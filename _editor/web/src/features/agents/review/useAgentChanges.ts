import type { AgentChange, AgentChangesResponse, AgentRepoChanges, FileDiffResponse } from "@intentic/api-contract";
import { useAsyncAction } from "@intentic/ui/async";
import {
    isTestPath,
    type AgentSpan,
    type AgentSummary,
    type LandConflictReason,
    type LandMode,
    type LandResult,
    type WorkspaceModule,
} from "@intentic/sandbox-contract";
import { computed, ref, watch, type Ref } from "vue";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import { sandboxJson, sandboxJsonAt } from "../../sandbox/client/sandboxClient";
import { AGENT_DIFF } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { askAgentToResolve, discardAgent, invalidateAgentAction, landAgent } from "../fleet/agentActions";
import { landedAway } from "../fleet/agentStatus";
import { blockersOf } from "./conflictResolution";
import { useAgents } from "../fleet/useAgents";

// Per-agent review of what a worktree has that main does not (GET /agents/{id}/diff): one flat set per repo, no
// staged/unstaged split. `landed` is read off the tree; committed files drop into `absorbed`. Land/discard replace
// commit/discard; this composable also tracks busy/error state, the last land's conflicts, and viewed progress.

// One row of the review, flattened from per-repo groups so selection, keyboard nav, and viewed-state can address a
// file by a single key. Key is JSON, not a delimiter, since repo id and path could collide on any separator.
export interface AgentReviewFile {
    readonly repo: string;
    readonly change: AgentChange;
    readonly key: string;
    // Repo-qualified path, as shown in tooltips, tabs, and diff headers.
    readonly label: string;
    // Why the last land refused this file, if it did (see LandConflictReason); undefined for unblocked rows.
    readonly blocked: LandConflictReason | undefined;
    // Commit carrying this file; set only on history rows, never on a reviewable (still-differing) one.
    readonly carriedBy?: { readonly sha: string; readonly short: string; readonly repo: string } | undefined;
}

const reviewFileKey = (repo: string, path: string): string => JSON.stringify([repo, path]);

// Named apart from the composable that reads it, so the background loader and the panel warm the same cache entry
// rather than parallel ones.
// `at` names the sandbox the agent is in; undefined means the active one, same convention as agentActions. The key
// encodes it too, since agent ids are per-sandbox and could otherwise collide across boxes.
export const agentChangesKey = (agentId: string, at?: string): unknown[] =>
    at === undefined ? AGENT_DIFF.of(agentId) : AGENT_DIFF.ofSandbox(at, agentId);

export const fetchAgentChanges = (agentId: string, at?: string): Promise<AgentChangesResponse> =>
    at === undefined
        ? sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(agentId)}/diff`)
        : sandboxJsonAt<AgentChangesResponse>(at, `/agents/${encodeURIComponent(agentId)}/diff`);

// Cached under the review's own key, so a list invalidation drops per-file diffs too, and warmed vs. clicked reads
// share one entry. UNPERSISTED: a diff is two full file texts.
export const agentFileDiffKey = (agentId: string, repo: string, path: string, at?: string): unknown[] => [
    ...agentChangesKey(agentId, at),
    UNPERSISTED,
    `file`,
    repo,
    path,
];

// staleTime Infinity: only a write invalidates a diff, and writes already do so; gcTime bounds memory.
export const AGENT_FILE_DIFF_OPTIONS = {
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    // No retry: a read-ahead must not multiply requests against a struggling daemon.
    retry: false as const,
};

export const readAgentFileDiff = async (agentId: string, repo: string, path: string, at?: string): Promise<FileDiffResponse> => {
    const route = `/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`;
    return at === undefined ? sandboxJson<FileDiffResponse>(route) : sandboxJsonAt<FileDiffResponse>(at, route);
};

// Named apart from the fetch call so the background loader can be handed the query directly.
export const agentFileDiffQuery = (agentId: string, repo: string, path: string, at?: string) => ({
    queryKey: agentFileDiffKey(agentId, repo, path, at),
    queryFn: () => readAgentFileDiff(agentId, repo, path, at),
    ...AGENT_FILE_DIFF_OPTIONS,
});

// Module-local; wraps the query above so the panel below is its only caller.
const agentFileDiff = (agentId: string, repo: string, path: string, at?: string): Promise<FileDiffResponse> =>
    queryClient.fetchQuery(agentFileDiffQuery(agentId, repo, path, at));

// Totals files and +/- lines for a subset of rows; feeds the header's code/test split chips.
const statOf = (subset: readonly AgentReviewFile[]): { files: number; additions: number; deletions: number } => ({
    files: subset.length,
    additions: subset.reduce((total, file) => total + (file.change.additions ?? 0), 0),
    deletions: subset.reduce((total, file) => total + (file.change.deletions ?? 0), 0),
});

// Per-agent set of files already viewed; module-level so navigating away and back keeps it, but lost on reload.
const viewedByAgent = ref<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
const NONE: ReadonlySet<string> = new Set();

// Agents whose land conflict the user has handed back to them; see `asked` below for how it's cleared.
const askedByAgent = ref<ReadonlySet<string>>(new Set());

// Empty agentId means no review yet (draft agent, or one the roster hasn't resolved); the query below stays
// disabled until it does.
// `at` is this agent's sandbox (undefined = active). Reads, land and discard cross sandboxes by id;
// askResolve/setAutoLand/archive use the local fleet store, active sandbox only. `agent` is the caller's resolved
// roster entry, used by `land`.
export function useAgentChanges(agentId: Ref<string>, at?: Ref<string | undefined>, agent?: Ref<Pick<AgentSummary, `landedPresence`> | undefined>) {
    const reach = computed(() => at?.value);
    const { query, error } = useSandboxQuery(
        {
            queryKey: computed(() => agentChangesKey(agentId.value, reach.value)),
            queryFn: () => fetchAgentChanges(agentId.value, reach.value),
            enabled: computed(() => agentId.value !== ``),
        },
        reach,
    );

    const repos = computed<readonly AgentRepoChanges[]>(() => query.data.value?.repos ?? []);

    // Files the user already committed (no row for them); otherwise an empty list looks like no work happened.
    const absorbed = computed(() => query.data.value?.absorbed ?? 0);

    // Per-repo package layout from the diff, not /workspace/modules: a new package may exist only in the worktree.
    const modulesByRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map(repos.value.map((group) => [group.repo, group.modules])),
    );
    const modulesOf = (repo: string): readonly WorkspaceModule[] => modulesByRepo.value.get(repo) ?? [];

    // From the daemon's query, not a local land call: the failing land is often automatic, so the panel opens cold.
    const conflicts = computed<LandResult[`conflicts`]>(() => query.data.value?.conflicts);
    // Keyed on (repo, path), like review rows; a repo-qualified label could collide on one unlucky filename.
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
    // What "Land now" would still apply to; zero once everything has landed.
    const pending = computed(() => files.value.filter((file) => !file.change.landed));
    // Rows the refusal names, derived from current rows so a reverted path is never still counted as blocked.
    const blocked = computed(() => files.value.filter((file) => file.blocked !== undefined));
    const additions = computed(() => files.value.reduce((total, file) => total + (file.change.additions ?? 0), 0));
    const deletions = computed(() => files.value.reduce((total, file) => total + (file.change.deletions ?? 0), 0));
    // Splits rows via the contract's isTestPath, so the header can show code vs. test proof separately.
    const codeStat = computed(() => statOf(files.value.filter((file) => !isTestPath(file.change.path))));
    const testStat = computed(() => statOf(files.value.filter((file) => isTestPath(file.change.path))));

    // One file's diff via the shared cached read above, so a row the loader already warmed opens without a round trip.
    const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> => agentFileDiff(agentId.value, repo, path);

    const viewed = computed<ReadonlySet<string>>(() => viewedByAgent.value.get(agentId.value) ?? NONE);
    // Counted over current rows, so a reverted file doesn't inflate progress.
    const viewedCount = computed(() => files.value.filter((file) => viewed.value.has(file.key)).length);
    // Takes a set of keys, not one: a per-key setter would copy the set and write N times for one heading toggle.
    const setViewed = (keys: readonly string[], on: boolean): void => {
        const next = new Set(viewed.value);
        for (const key of keys) {
            if (on) {
                next.add(key);
            } else {
                next.delete(key);
            }
        }
        const byAgent = new Map(viewedByAgent.value);
        byAgent.set(agentId.value, next);
        viewedByAgent.value = byAgent;
    };

    const { busy: actionBusy, notice: actionError, run } = useAsyncAction();

    // Paths a `merge` land left with conflict markers, for the panel to hand back to the user to finish.
    const resolving = ref<LandResult[`resolving`]>(undefined);

    // Whether the user asked the agent to resolve; cleared when the conflict report changes (fresh report wins).
    const asked = computed(() => askedByAgent.value.has(agentId.value));
    watch(conflicts, () => {
        if (askedByAgent.value.has(agentId.value)) {
            const next = new Set(askedByAgent.value);
            next.delete(agentId.value);
            askedByAgent.value = next;
        }
    });

    // True when landedPresence shows landed work missing from the tree (e.g. discarded post-land), so `land` uses
    // `cumulative` rather than an emptied `outstanding`.
    const missing = computed(() => agent?.value !== undefined && landedAway(agent.value) !== undefined);
    // `force` answers the mid-write warning prompt; a parked turn needs none.
    const land = (mode: LandMode = `check`, span?: AgentSpan, force = false): Promise<void> =>
        run(async () => {
            const rung: AgentSpan = span ?? (missing.value ? `cumulative` : `outstanding`);
            resolving.value = (await landAgent(agentId.value, mode, rung, force, reach.value)).resolving;
            await invalidateAgentAction(agentId.value, reach.value);
        }, `Land failed.`);

    // This agent's auto-land override (null = inherit the sandbox setting); routed through `run` so a refusal surfaces
    // in the panel's error line.
    const setAutoLand = (autoLand: boolean | null): Promise<void> =>
        run(() => useAgents().setAutoLand(agentId.value, autoLand), `Couldn't change when this agent lands.`);

    // Hands the conflict to the agent; `askedByAgent` is set only once the send succeeds. A refusal (e.g. a stale
    // report) surfaces through actionError like any other declined mutation.
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
            await discardAgent(agentId.value, reach.value);
            resolving.value = undefined;
            await invalidateAgentAction(agentId.value, reach.value);
        }, `Discard failed.`);

    // Finishing with an agent rather than its work, the panel's counterpart to the board's archive action; the diff
    // still renders after archiving (re-read from the branch).
    const archive = (): Promise<void> => run(() => useAgents().archive([agentId.value]), `Archive failed.`);

    return {
        repos,
        modulesOf,
        files,
        count,
        absorbed,
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
