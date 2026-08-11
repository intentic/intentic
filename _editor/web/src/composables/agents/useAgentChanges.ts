import type { AgentChange, AgentChangesResponse, AgentRepoChanges, FileDiffResponse } from "@intentic-app/api-contract";
import { useAsyncAction } from "@intentic/ui/async";
import {
    isTestPath,
    type AgentSpan,
    type LandConflictReason,
    type LandMode,
    type LandResult,
    type WorkspaceModule,
} from "@intentic/sandbox-contract";
import { computed, ref, watch, type Ref } from "vue";
import { rendersAsBytes } from "../../pages/workspace/fileType";
import { queryClient, UNPERSISTED } from "../queryPersistence";
import { useCodeStats } from "../workspace/useCodeStats";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { askAgentToResolve, discardAgent, invalidateAgentAction, landAgent } from "./agentActions";
import { blockersOf } from "./conflictResolution";
import { useAgents } from "./useAgents";

/* Per-agent isolated review — one conversation worktree's CUMULATIVE output (GET /agents/{id}/diff, the
 * AgentChanges wire shape: one flat set per repo, no staged/unstaged split, because a worktree the user never
 * checks out has no index they could stage into). Every row carries `landed`, so the panel can show the whole
 * body of work — the normal case, since a clean turn auto-lands within ms — while still telling apart what
 * "Land now" would still apply. The actions are land (patch the remainder into the main tree) and discard
 * (drop worktree + branch + registry entry) instead of commit/discard. Parameterized by agent id — each review
 * panel instance owns its own query.
 *
 * The mutations themselves live in agentActions (the board's drag-to-act drops fire the same ones); what this
 * adds is the panel's own busy/error reporting, the last land attempt's conflicts, and the review's own
 * progress (which files the user has already looked at). */

// One row of the review, flattened out of the per-repo groups so selection, keyboard navigation and the
// viewed-set can address a file by a single key without carrying two fields everywhere. JSON rather than a
// delimiter, like the Changes panel's rowKey: a repo id is a directory name and a path is arbitrary, so any
// literal separator is one unlucky filename away from two rows sharing a key.
export interface AgentReviewFile {
    readonly repo: string;
    readonly change: AgentChange;
    readonly key: string;
    // Repo-qualified path — what a tooltip, a workspace tab, or the diff header names the file.
    readonly label: string;
    /* Why the last land refused THIS file, if it did (see LandConflictReason). Carried on the row rather than
     * looked up per surface, because the conflict report and the file list were otherwise two readings of the
     * same refusal that could disagree: the report named a handful of paths in prose above a list of thirty
     * rows that all looked alike, so the one question the user actually had — "which of these is the problem,
     * and whose problem is it?" — was answered by neither. `undefined` for the overwhelming majority of rows,
     * including every row of an agent that never conflicted. */
    readonly blocked: LandConflictReason | undefined;
}

const reviewFileKey = (repo: string, path: string): string => JSON.stringify([repo, path]);

/* THE REVIEW'S OWN READ, named apart from the composable that observes it — so the background loader can warm
 * the same cache entry the panel later reads, rather than a parallel one. Both halves have to be shared for
 * that to hold: the key (or the warm lands somewhere the panel never looks) and the request (or the two
 * disagree the first time one of them changes). */
export const agentChangesKey = (agentId: string): unknown[] => sandboxKey(`agents`, agentId, `diff`);

export const fetchAgentChanges = (agentId: string): Promise<AgentChangesResponse> =>
    sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(agentId)}/diff`);

/* ONE ROW'S DIFF, cached under the review's own key — so the invalidation that refreshes the file list (a land,
 * a discard, a turn settling) drops the per-file diffs with it, and a warmed row and a clicked row are one
 * entry rather than two. Concurrent callers share one request, which is what lets a click land on a file the
 * background loader is already reading and simply wait for that read instead of racing it.
 *
 * UNPERSISTED, like the workspace review's: a diff is two whole file texts, and the loader reads one per
 * changed file. queryPersistence holds what putting that in the disk mirror would charge every other write. */
export const agentFileDiffKey = (agentId: string, repo: string, path: string): unknown[] => [
    ...agentChangesKey(agentId),
    UNPERSISTED,
    `file`,
    repo,
    path,
];

// Where this row's code-only +/− is filed (useCodeStats). Scoped to the agent, because the same path in two
// agents' worktrees is two different changes.
export const agentStatKey = (agentId: string, repo: string, path: string): string => `agent:${agentId}:${reviewFileKey(repo, path)}`;

/* THE CACHING TERMS, shared rather than defaulted — because the panel OBSERVES this query while the loader
 * merely fills it, and an observer that brought vue-query's defaults would undo the warming it is supposed to
 * benefit from: a default staleTime of 0 makes mounting one refetch on the spot, so every warmed row would be
 * re-read the instant it was looked at.
 *
 * staleTime Infinity for the reason the workspace review's diffs give: time is not what makes a diff wrong, a
 * write is, and every write already invalidates the list these are filed under. gcTime is the memory bound that
 * follows — warmed rows nobody opened are collected a few minutes after the review moved on. */
export const AGENT_FILE_DIFF_OPTIONS = {
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    // No retry — see the workspace review's file diff for why a read-ahead must not multiply its own requests
    // against a daemon that is having a moment.
    retry: false as const,
};

export const readAgentFileDiff = async (agentId: string, repo: string, path: string): Promise<FileDiffResponse> => {
    const body = await sandboxJson<FileDiffResponse>(
        `/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`,
    );
    /* Counted here rather than by whoever asked, for the reason the workspace review's read gives at length: the
     * count needs both whole sides of the file, this read just paid for them, and every caller then gets it at the
     * same price.
     *
     * Bytes and oversized files have no text to strip, and that is an ANSWER rather than an absence: their pane
     * shows the file as it is, so git's counts are what the reader is looking at. Written off explicitly, because
     * leaving them unrecorded left the badge unable to tell them from a file whose count had not been taken yet —
     * so it printed git's number for both, and for one of the two that number was about to change. */
    const stats = useCodeStats();
    const key = agentStatKey(agentId, repo, path);
    if (body.truncated === true || rendersAsBytes(path, body.binary)) {
        stats.noCode(key);
    } else {
        void stats.record(key, path, body.before ?? ``, body.after ?? ``);
    }
    return body;
};

/* The query, named apart from the call, so the background loader can be handed the QUERY rather than a function
 * that fetches it — see agentTranscriptQuery for what having those two halves separable cost. */
export const agentFileDiffQuery = (agentId: string, repo: string, path: string) => ({
    queryKey: agentFileDiffKey(agentId, repo, path),
    queryFn: () => readAgentFileDiff(agentId, repo, path),
    ...AGENT_FILE_DIFF_OPTIONS,
});

// Module-local: the loader takes the query above rather than a function that runs it, so the panel below is the
// only caller left.
const agentFileDiff = (agentId: string, repo: string, path: string): Promise<FileDiffResponse> =>
    queryClient.fetchQuery(agentFileDiffQuery(agentId, repo, path));

// Files/±lines of a review subset — the header's split chips total code and tests through this one shape.
const statOf = (subset: readonly AgentReviewFile[]): { files: number; additions: number; deletions: number } => ({
    files: subset.length,
    additions: subset.reduce((total, file) => total + (file.change.additions ?? 0), 0),
    deletions: subset.reduce((total, file) => total + (file.change.deletions ?? 0), 0),
});

// Which files the user has already eyeballed, per agent id — a GitHub-style "viewed" pass, and the one piece of
// review state the daemon has no opinion about. Module-level, so stepping out to the workspace and back does
// not lose the pass; in-memory only, because a reload means a fresh look anyway.
const viewedByAgent = ref<Record<string, ReadonlySet<string>>>({});
const NONE: ReadonlySet<string> = new Set();

// The agents whose land conflict the user has handed back to them — see `asked` below for what retires it.
const askedByAgent = ref<ReadonlySet<string>>(new Set());

// An EMPTY id means "no review on this screen" — a draft agent, an id the roster hasn't resolved yet. The
// caller owns the review's state for the whole page (AgentDetail), so it exists before it is known whether
// there is anything to read; without this the page would ask the daemon for the diff of an agent that has
// never run, and be told so, once per visit.
export function useAgentChanges(agentId: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => agentChangesKey(agentId.value)),
        queryFn: () => fetchAgentChanges(agentId.value),
        enabled: computed(() => agentId.value !== ``),
    });

    const repos = computed<readonly AgentRepoChanges[]>(() => query.data.value?.repos ?? []);

    /* THE PACKAGE LAYOUT the review groups this agent's rows under — read off the diff itself, never from the
     * workspace-wide /workspace/modules that the Changes panel uses. Same call shape as that one (useModules'
     * `modulesOf`), deliberately, so the two review lists group through an identical seam; what differs is only
     * WHOSE tree answered, which is the whole point.
     *
     * The workspace read walks /work, and an agent works in a worktree of its own. A package the agent has just
     * created has its manifest only there, so /work could not name it — and that is the case where the naming
     * matters most, because every file of a new package is a change. The review listed all of them as loose
     * files of the repo, under no package at all, with their paths shortened to bare filenames.
     *
     * Keyed by the {repo} id every row already carries, so a lookup is never a scan. */
    const modulesByRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map(repos.value.map((group) => [group.repo, group.modules])),
    );
    const modulesOf = (repo: string): readonly WorkspaceModule[] => modulesByRepo.value.get(repo) ?? [];

    /* Why the last land refused — read from the DAEMON, not from the land call this browser made. The land
     * that conflicts is almost always the automatic one at turn completion, which no browser asked for: the
     * user learns about it from the card and clicks "See what blocked it", which opens this panel cold. Held in
     * a local ref, the report was empty on exactly that path — the panel rendered no explanation and no merge
     * action, so the one affordance the board offers for a conflict led nowhere. Landing invalidates this
     * query, so an attempt made here still refreshes it, one round trip later. */
    const conflicts = computed<LandResult[`conflicts`]>(() => query.data.value?.conflicts);
    // The refusal, keyed the way the review keys its rows, so the join below is a lookup rather than a scan per
    // row — and so it is keyed on the pair, never on the repo-qualified label, which one unlucky filename in a
    // multi-repo composition would make ambiguous (see reviewFileKey).
    const blockedBy = computed(
        () => new Map(blockersOf(conflicts.value).map((blocker) => [reviewFileKey(blocker.repo, blocker.path), blocker.reason])),
    );

    const files = computed<readonly AgentReviewFile[]>(() =>
        repos.value.flatMap((group) =>
            group.changes.map((change) => {
                const key = reviewFileKey(group.repo, change.path);
                return {
                    repo: group.repo,
                    change,
                    key,
                    label: group.repo === `root` ? change.path : `${group.repo}/${change.path}`,
                    blocked: blockedBy.value.get(key),
                };
            }),
        ),
    );
    const count = computed(() => files.value.length);
    // What "Land now" would still apply — zero once everything has landed, which is the steady state.
    const pending = computed(() => files.value.filter((file) => !file.change.landed));
    /* The rows the refusal is actually about — a strict subset of `pending` (a check land is atomic, so a
     * refusal leaves everything unlanded, blocked or not) and usually a tiny one. It is the number that says
     * how little is wrong, and the list the review has to be able to narrow itself to. Derived from the ROWS
     * rather than counted off the report so it can never claim more files than the list can show: a blocker on
     * a path the agent has since reverted has no row to mark and does not belong in a filter's count. */
    const blocked = computed(() => files.value.filter((file) => file.blocked !== undefined));
    const additions = computed(() => files.value.reduce((total, file) => total + (file.change.additions ?? 0), 0));
    const deletions = computed(() => files.value.reduce((total, file) => total + (file.change.deletions ?? 0), 0));
    // The change vs the proof: one classifier (the contract's isTestPath) splits the review so the header can
    // answer "how much of this is tests?" at a glance — a +2k diff that is half test coverage reads very
    // differently from +2k of product surface, and the combined number hides exactly that.
    const codeStat = computed(() => statOf(files.value.filter((file) => !isTestPath(file.change.path))));
    const testStat = computed(() => statOf(files.value.filter((file) => isTestPath(file.change.path))));

    // One file's diff, through the shared cached read above — so the row the background loader already warmed
    // opens without a round trip, and the +/− beside it is already counted.
    const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> => agentFileDiff(agentId.value, repo, path);

    const viewed = computed<ReadonlySet<string>>(() => viewedByAgent.value[agentId.value] ?? NONE);
    // Counted over the CURRENT rows, so a file the agent has since reverted stops inflating the progress.
    const viewedCount = computed(() => files.value.filter((file) => viewed.value.has(file.key)).length);
    // A SET of keys, not one: the panel ticks whole headings off (a repo, a package), and a per-key setter made
    // that N set copies and N reactive writes for one gesture — every row of the list repainting N times.
    const setViewed = (keys: readonly string[], on: boolean): void => {
        const next = new Set(viewed.value);
        for (const key of keys) {
            if (on) {
                next.add(key);
            } else {
                next.delete(key);
            }
        }
        viewedByAgent.value = { ...viewedByAgent.value, [agentId.value]: next };
    };

    const { busy: actionBusy, notice: actionError, run } = useAsyncAction();

    // Paths a `merge` land wrote into the workspace with conflict markers on them, for the panel to hand back
    // to the user as work to finish. Local, because unlike `conflicts` it describes an attempt rather than a
    // state: nothing on the daemon still knows those markers are outstanding once the user resolves them.
    const resolving = ref<LandResult[`resolving`]>(undefined);

    /* Has the user handed this conflict back to the agent? Local like `resolving`, and for the same reason —
     * the daemon records the OUTCOME of a land, not why a turn was started, so nothing on it can tell a turn
     * that is rebasing away a conflict from an ordinary follow-up message.
     *
     * Its whole job is to keep the panel from claiming the conflict is still the user's move while the agent
     * is already fixing it. The definitive answer to "did it work" is a CHANGED conflict report, so that is
     * what retires it: cleared on its way in (undefined ⇒ the block unmounts entirely) or replaced by a fresh
     * refusal (⇒ the buttons come back, over a report that is actually current). vue-query's structural
     * sharing means a refetch that changed nothing doesn't fire this, so watching the value is enough.
     * Keyed by agent id at module level, like the viewed set: stepping out to the workspace and back is not
     * the user withdrawing the request. */
    const asked = computed(() => askedByAgent.value.has(agentId.value));
    watch(conflicts, () => {
        if (askedByAgent.value.has(agentId.value)) {
            const next = new Set(askedByAgent.value);
            next.delete(agentId.value);
            askedByAgent.value = next;
        }
    });

    // `span` is `cumulative` only for "Land again" — the way back after landed work was discarded from the
    // workspace, where every sha says the work went in and only a reading from the branch's base can still see
    // that it is gone (AgentSpanSchema).
    const land = (mode: LandMode = `check`, span: AgentSpan = `outstanding`): Promise<void> =>
        run(async () => {
            resolving.value = (await landAgent(agentId.value, mode, span)).resolving;
            await invalidateAgentAction(agentId.value);
        }, `Land failed.`);

    // The panel's hold toggle — this agent's auto-land override (null ⇒ back to inheriting the sandbox
    // setting). Through `run` like every other mutation here, so a refusal reports in the panel's own error
    // line instead of a silently-unflipped icon; the optimistic registry write inside setAutoLand is what
    // repaints the toggle on the click itself.
    const setAutoLand = (autoLand: boolean | null): Promise<void> =>
        run(() => useAgents().setAutoLand(agentId.value, autoLand), `Couldn't change when this agent lands.`);

    // Hand the conflict to the agent (agentActions.askAgentToResolve). The flag is set only once the turn is
    // away, so a send that fails leaves the buttons where they were rather than parking the panel on a
    // "resolving" state nothing is working on. A REFUSED ask is such a failure: this panel hides the button
    // when the report says a rebase can't reach the conflict, but the report it hid it on can be a round trip
    // stale — the ask re-reads it, and its answer is the authority, so it reports through actionError like any
    // other declined mutation rather than being dropped on the floor.
    const askResolve = (): Promise<void> =>
        run(async () => {
            const ask = await askAgentToResolve(agentId.value);
            if (!ask.sent) {
                throw new Error(ask.why);
            }
            askedByAgent.value = new Set(askedByAgent.value).add(agentId.value);
        }, `Couldn't ask the agent to resolve it.`);

    const discard = (): Promise<void> =>
        run(async () => {
            await discardAgent(agentId.value);
            resolving.value = undefined;
            await invalidateAgentAction(agentId.value);
        }, `Discard failed.`);

    // Finishing WITH an agent, as opposed to finishing its work — the panel's counterpart to the board's
    // archive affordance, offered here because the review is where a user decides they are done looking. The
    // diff survives archiving (it is re-read from the branch), so the panel keeps rendering afterwards.
    const archive = (): Promise<void> => run(() => useAgents().archive([agentId.value]), `Archive failed.`);

    return {
        repos,
        modulesOf,
        files,
        count,
        pending,
        blocked,
        additions,
        deletions,
        codeStat,
        testStat,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        viewed,
        viewedCount,
        setViewed,
        land,
        setAutoLand,
        askResolve,
        discard,
        archive,
        conflicts,
        resolving,
        asked,
        actionBusy,
        actionError,
    };
}
