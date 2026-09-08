import type { AgentHistoryCommit, AgentHistoryResponse } from "@intentic/api-contract";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { sandboxJson, sandboxJsonAt } from "../../sandbox/client/sandboxClient";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { agentChangesKey, type AgentReviewFile } from "../review/useAgentChanges";

// The other half of the review: what this conversation wrote that's already in your own history, and which commits hold
// it. The review only lists what still differs from main, so committing an agent's work retires its rows, leaving the
// reader nowhere to find it; this hands back the same AgentReviewFile rows under a filter, so every review mechanism
// works on them for free.

// Filed under the review's own key, not beside it, so it needs no invalidation of its own: whatever makes the review
// stale makes this stale too.
export const agentHistoryKey = (agentId: string, at?: string): unknown[] => [...agentChangesKey(agentId, at), `history`];

export const fetchAgentHistory = (agentId: string, at?: string): Promise<AgentHistoryResponse> =>
    at === undefined
        ? sandboxJson<AgentHistoryResponse>(`/agents/${encodeURIComponent(agentId)}/history`)
        : sandboxJsonAt<AgentHistoryResponse>(at, `/agents/${encodeURIComponent(agentId)}/history`);

// One commit as the panel's summary renders it: its own fields plus which repo and how much of this conversation's work
// it carries.
export interface AgentHistoryEntry extends AgentHistoryCommit {
    readonly repo: string;
}

export function useAgentHistory(agentId: Ref<string>, enabled: Ref<boolean>, at?: Ref<string | undefined>) {
    const reach = computed(() => at?.value);
    const { query, error } = useSandboxQuery(
        {
            queryKey: computed(() => agentHistoryKey(agentId.value, reach.value)),
            queryFn: () => fetchAgentHistory(agentId.value, reach.value),
            enabled: computed(() => agentId.value !== `` && enabled.value),
        },
        reach,
    );

    const repos = computed(() => query.data.value?.repos ?? []);

    const commits = computed<readonly AgentHistoryEntry[]>(() =>
        repos.value.flatMap((group) => group.commits.map((commit) => ({ ...commit, repo: group.repo }))),
    );

    // Keyed exactly as the review's rows are (repo + path as JSON), so the viewed pass and selection address a file the
    // same way from either list.
    const files = computed<readonly AgentReviewFile[]>(() =>
        repos.value.flatMap((group) =>
            group.commits.flatMap((commit) =>
                commit.changes.map((change) => ({
                    repo: group.repo,
                    change: { ...change, landed: true },
                    key: JSON.stringify([group.repo, change.path]),
                    label: group.repo === `root` ? change.path : `${group.repo}/${change.path}`,
                    // A committed file can't be blocking a land: a land is refused over the working tree, and this one
                    // is no longer in it.
                    blocked: undefined,
                    carriedBy: { sha: commit.sha, short: commit.short, repo: group.repo },
                })),
            ),
        ),
    );

    // The same seam the review's grouping reads through, but its own: a repo the user has fully committed has no entry
    // in the review to name its packages.
    const modulesByRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map(repos.value.map((group) => [group.repo, group.modules])),
    );

    return {
        files,
        commits,
        count: computed(() => files.value.length),
        modulesOf: (repo: string): readonly WorkspaceModule[] => modulesByRepo.value.get(repo) ?? [],
        // Absorbed files no commit in the span accounts for, surfaced rather than swallowed: content can reach main by
        // roads other than a commit since the land.
        unaccounted: computed(() => query.data.value?.unaccounted ?? 0),
        loading: query.isFetching,
        error,
    };
}
