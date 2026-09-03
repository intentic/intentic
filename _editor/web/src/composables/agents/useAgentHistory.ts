import type { AgentHistoryCommit, AgentHistoryResponse } from "@intentic-app/api-contract";
import type { WorkspaceModule } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import { sandboxJson, sandboxJsonAt } from "../sandbox/sandboxClient";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { agentChangesKey, type AgentReviewFile } from "./useAgentChanges";

/* THE OTHER HALF OF THE REVIEW: what this conversation wrote that is IN YOUR OWN HISTORY, and which commits
 * hold it (GET /agents/{id}/history).
 *
 * The review lists what still differs from main, so committing an agent's work is what retires its rows: they
 * are the user's own history then, not a difference against anything. That is the right rule and the panel
 * argues for it at length, but it left the reader at a dead end, an empty panel and one sentence saying the
 * work is "in your workspace's history", at the exact moment they had come to look at what the agent did. The
 * work was findable the whole time; nothing looked for it.
 *
 * ROWS OF THE SAME SHAPE the review already renders, deliberately: the file list, the module grouping, the
 * size rail, the keyboard pass and the diff pane are all written against AgentReviewFile, and committed work
 * is not a different KIND of thing to read. So this hands back the same rows under a filter of their own, and
 * every one of those mechanisms works on them for free.
 *
 * `landed: true` on every row is a fact, not a placeholder: absorbed implies in-workspace (the daemon's
 * `verdicts` treats history holding the content as the strongest possible "your workspace has it"), so the
 * "not landed" dot correctly never appears on one of these.
 *
 * LAZY. It costs a `git log` per repo on the daemon and answers nothing at all until the user has committed
 * something, so the panel enables it only once the review has told it there is an answer to have (`absorbed`).
 */

/* Filed UNDER the review's own key rather than beside it, exactly as the per-file diffs are, so it needs no
 * invalidation of its own: whatever makes the review stale (a land, a discard, a turn settling) makes this
 * stale by the same act, and AGENT_DIFF.matches already reaches everything below that prefix. */
export const agentHistoryKey = (agentId: string, at?: string): unknown[] => [...agentChangesKey(agentId, at), `history`];

export const fetchAgentHistory = (agentId: string, at?: string): Promise<AgentHistoryResponse> =>
    at === undefined
        ? sandboxJson<AgentHistoryResponse>(`/agents/${encodeURIComponent(agentId)}/history`)
        : sandboxJsonAt<AgentHistoryResponse>(at, `/agents/${encodeURIComponent(agentId)}/history`);

// One commit as the panel's summary renders it: the commit's own fields, plus which repo it is in and how much
// of this conversation's work it carries. Flattened out of the per-repo groups for the same reason the rows
// are, a summary line reads down the commits, not down the repos.
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

    /* The rows, keyed exactly as the review's are (repo + path as JSON, never a delimiter a filename could
     * contain), so the viewed pass and the selection address a file the same way whichever list it came from.
     * `carriedBy` is what the row's badge and the summary above the list are drawn from. */
    const files = computed<readonly AgentReviewFile[]>(() =>
        repos.value.flatMap((group) =>
            group.commits.flatMap((commit) =>
                commit.changes.map((change) => ({
                    repo: group.repo,
                    change: { ...change, landed: true },
                    key: JSON.stringify([group.repo, change.path]),
                    label: group.repo === `root` ? change.path : `${group.repo}/${change.path}`,
                    // A committed file cannot be blocking a land: a land is refused over the working tree, and
                    // this one is not in it any more.
                    blocked: undefined,
                    carriedBy: { sha: commit.sha, short: commit.short, repo: group.repo },
                })),
            ),
        ),
    );

    // The same seam the review's grouping reads through, and it has to be its OWN: a repo whose every file the
    // user committed has no entry in the review at all, so the review's module map cannot name its packages.
    const modulesByRepo = computed<ReadonlyMap<string, readonly WorkspaceModule[]>>(
        () => new Map(repos.value.map((group) => [group.repo, group.modules])),
    );

    return {
        files,
        commits,
        count: computed(() => files.value.length),
        modulesOf: (repo: string): readonly WorkspaceModule[] => modulesByRepo.value.get(repo) ?? [],
        /* Absorbed files no commit in the span accounts for. Surfaced rather than swallowed: content reaches
         * the main line by roads other than a commit since the land (a cherry-pick, another conversation
         * landing the same lines, the user typing them by hand), and a panel that quietly dropped those would
         * be claiming the commits it names are the whole story. */
        unaccounted: computed(() => query.data.value?.unaccounted ?? 0),
        loading: query.isFetching,
        error,
    };
}
