import type { AgentChange, AgentChangesResponse, AgentRepoChanges, FileDiffResponse } from "@intentic-app/api-contract";
import type { LandMode, LandResult } from "@intentic/sandbox-contract";
import { computed, ref, watch, type Ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";
import { discardAgent, invalidateAgentAction, landAgent } from "./agentActions";
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
}

const reviewFileKey = (repo: string, path: string): string => JSON.stringify([repo, path]);

// Which files the user has already eyeballed, per agent id — a GitHub-style "viewed" pass, and the one piece of
// review state the daemon has no opinion about. Module-level, so stepping out to the workspace and back does
// not lose the pass; in-memory only, because a reload means a fresh look anyway.
const viewedByAgent = ref<Record<string, ReadonlySet<string>>>({});
const NONE: ReadonlySet<string> = new Set();

export function useAgentChanges(agentId: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`agents`, agentId.value, `diff`)),
        queryFn: () => sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(agentId.value)}/diff`),
    });

    const repos = computed<readonly AgentRepoChanges[]>(() => query.data.value?.repos ?? []);
    const files = computed<readonly AgentReviewFile[]>(() =>
        repos.value.flatMap((group) =>
            group.changes.map((change) => ({
                repo: group.repo,
                change,
                key: reviewFileKey(group.repo, change.path),
                label: group.repo === `root` ? change.path : `${group.repo}/${change.path}`,
            })),
        ),
    );
    const count = computed(() => files.value.length);
    // What "Land now" would still apply — zero once everything has landed, which is the steady state.
    const pending = computed(() => files.value.filter((file) => !file.change.landed));
    const additions = computed(() => files.value.reduce((total, file) => total + (file.change.additions ?? 0), 0));
    const deletions = computed(() => files.value.reduce((total, file) => total + (file.change.deletions ?? 0), 0));

    // Per-file diffs, cached for the length of one review pass: arrowing up and down the list re-selects files
    // constantly, and each miss is a daemon round-trip. vue-query's structural sharing keeps `repos` identical
    // across a refetch that changed nothing, so this only clears when the agent's output actually moved.
    const diffCache = new Map<string, FileDiffResponse>();
    watch(repos, () => diffCache.clear());

    const fileDiff = async (repo: string, path: string): Promise<FileDiffResponse> => {
        const key = reviewFileKey(repo, path);
        const cached = diffCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const body = await sandboxJson<FileDiffResponse>(
            `/agents/${encodeURIComponent(agentId.value)}/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`,
        );
        diffCache.set(key, body);
        return body;
    };

    const viewed = computed<ReadonlySet<string>>(() => viewedByAgent.value[agentId.value] ?? NONE);
    // Counted over the CURRENT rows, so a file the agent has since reverted stops inflating the progress.
    const viewedCount = computed(() => files.value.filter((file) => viewed.value.has(file.key)).length);
    const setViewed = (key: string, on: boolean): void => {
        const next = new Set(viewed.value);
        if (on) {
            next.add(key);
        } else {
            next.delete(key);
        }
        viewedByAgent.value = { ...viewedByAgent.value, [agentId.value]: next };
    };

    const { busy: actionBusy, error: actionError, run } = useAsyncAction();
    // The conflicts of the last land attempt, for the conflict panel; cleared by a clean land or discard.
    const conflicts = ref<LandResult[`conflicts`]>(undefined);

    // Paths a `merge` land wrote into the workspace with conflict markers on them, for the panel to hand back
    // to the user as work to finish. Like `conflicts`, it describes the LAST attempt only.
    const resolving = ref<LandResult[`resolving`]>(undefined);

    const land = (mode: LandMode = `check`): Promise<void> =>
        run(async () => {
            const result = await landAgent(agentId.value, mode);
            conflicts.value = result.conflicts;
            resolving.value = result.resolving;
            await invalidateAgentAction(agentId.value);
        }, `Land failed.`);

    const discard = (): Promise<void> =>
        run(async () => {
            await discardAgent(agentId.value);
            conflicts.value = undefined;
            resolving.value = undefined;
            await invalidateAgentAction(agentId.value);
        }, `Discard failed.`);

    // Finishing WITH an agent, as opposed to finishing its work — the panel's counterpart to the board's
    // archive affordance, offered here because the review is where a user decides they are done looking. The
    // diff survives archiving (it is re-read from the branch), so the panel keeps rendering afterwards.
    const archive = (): Promise<void> => run(() => useAgents().archive([agentId.value]), `Archive failed.`);

    return {
        repos,
        files,
        count,
        pending,
        additions,
        deletions,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        viewed,
        viewedCount,
        setViewed,
        land,
        discard,
        archive,
        conflicts,
        resolving,
        actionBusy,
        actionError,
    };
}
