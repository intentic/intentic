import {
    type FileDiff,
    FileDiffSchema,
    type GitActionResult,
    GitActionResultSchema,
    type GitCommit,
    type GitCommitDiff,
    GitCommitDiffSchema,
    type GitDiffSide,
    GitLogSchema,
} from "@intentic/sandbox-contract";
import { useInfiniteQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useRefRefresh } from "./useRefRefresh.js";

/* One repo's commit graph — the daemon's `git log --all` (newest-first, across every ref, so branch topology
 * shows). The log is the query; per-commit detail (the files a commit touched, then a file's before/after AT
 * the commit) loads lazily on selection. Parameterized by a reactive repo so a caller can swap repos and the
 * query re-keys.
 *
 * The cache key goes through `api.sandbox.key`, which scopes it to the ACTIVE sandbox — a switch must not show
 * the previous box's history. Responses are parsed against the wire schemas rather than asserted: this is the
 * extension boundary, and a daemon that has moved on should fail here rather than three components deeper. */

const encode = (value: string): string => encodeURIComponent(value);

// The ref-only verbs (branch, tag) answer a bare ok and throw on a git error the caller surfaces — a duplicate
// name, an illegal ref. The sequence and HEAD-moving verbs answer a GitActionResult, where `ok: false` is a
// clean-apply conflict: an expected outcome the dialog reports, not a throw.
const ok = (): void => undefined;
const action = (value: unknown): GitActionResult => GitActionResultSchema.parse(value);

export function useGitLog(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    /* PAGED. A large repository's log is tens of thousands of commits, and every one of them costs a schema
     * validation, a wire payload and a lane computation before a single row is drawn — so the graph takes a page
     * at a time and asks for the next when the reader reaches the bottom.
     *
     * The page size is the daemon's own default rather than a number chosen here: one page is already more than
     * fits on any screen, so the first request is what the reader sees and the rest is scrolling. */
    const PAGE = 300;
    const logKey = computed(() => api.sandbox.key(`git-history`, `log`, repo.value));
    const query = useInfiniteQuery({
        queryKey: logKey,
        queryFn: async ({ pageParam }) =>
            GitLogSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/log?limit=${PAGE}&skip=${pageParam}`)),
        initialPageParam: 0,
        // `hasMore` comes from the daemon asking git for one commit more than it returned, so this is a fact
        // rather than a guess from a full-looking page.
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
        enabled: computed(() => api.sandbox.reachable()),
    });

    // A ref moving in THIS repo — the agent's commit, a land, a rebase in a terminal — makes the log stale
    // with no request here to hang an invalidation on.
    useRefRefresh(repo, [`log`]);

    const commits = computed<readonly GitCommit[]>(() => query.data.value?.pages.flatMap((page) => page.commits) ?? []);
    const branch = computed(() => query.data.value?.pages[0]?.branch);

    // The changed-files list for a commit (vs its first parent), then one file's diff AT that commit. Both keyed
    // to the current repo — the caller resolves them when a commit / file is clicked.
    const commitFiles = async (sha: string): Promise<GitCommitDiff> =>
        GitCommitDiffSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/commit-diff?sha=${encode(sha)}`));
    const commitFileDiff = async (sha: string, path: string): Promise<FileDiff> =>
        FileDiffSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/commit-file-diff?sha=${encode(sha)}&path=${encode(path)}`));
    // The working tree's counterpart, for row zero. `side` matters: a partially staged file's staged half
    // (index vs HEAD) and unstaged half (worktree vs index) are two different diffs of one path.
    const workingFileDiff = async (path: string, side: GitDiffSide): Promise<FileDiff> =>
        FileDiffSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/file-diff?path=${encode(path)}&side=${encode(side)}`));

    /* A write action moves refs and may move HEAD and the worktree with them. This invalidates what THIS
     * extension owns; every other surface converges on its own — the daemon's watcher pushes the worktree change
     * to the app's Changes review and file tree, and its ref push (api.workspace.onDidChangeRefs, wired in
     * extension.ts) brings back anything keyed off the refs. Reaching into the app's cache keys from here is
     * exactly the coupling this extension exists to not have. */
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: logKey.value });

    const post = async <T>(route: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> => {
        const result = parse(
            await api.sandbox.json(`/git/${encode(repo.value)}/${route}`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(body),
            }),
        );
        await invalidate();
        return result;
    };
    return {
        commits,
        branch,
        loading: query.isFetching,
        // What the bottom of the list offers. `fetchingMore` is separate from `loading` so pulling the next page
        // does not make the whole graph look like it is reloading.
        hasMore: computed(() => query.hasNextPage.value),
        fetchingMore: computed(() => query.isFetchingNextPage.value),
        loadMore: (): void => void query.fetchNextPage(),
        error: computed(() => query.error.value?.message),
        refresh: (): Promise<void> => invalidate(),
        commitFiles,
        commitFileDiff,
        workingFileDiff,
        createBranch: (sha: string, name: string): Promise<void> => post(`branch`, { sha, name }, ok),
        createTag: (sha: string, name: string): Promise<void> => post(`tag`, { sha, name }, ok),
        // A tag's other two verbs, so its pill is not a create-only affordance. `remote` is optional on delete:
        // absent means local only, which is what a tag that was never pushed wants.
        deleteTag: (name: string, remote?: string): Promise<void> => post(`tag/delete`, { name, ...(remote !== undefined ? { remote } : {}) }, ok),
        pushTag: (name: string, remote: string): Promise<GitActionResult> => post(`tag/push`, { name, remote }, action),
        checkout: (ref: string): Promise<GitActionResult> => post(`checkout`, { ref }, action),
        cherryPick: (sha: string): Promise<GitActionResult> => post(`cherry-pick`, { sha }, action),
        revert: (sha: string): Promise<GitActionResult> => post(`revert`, { sha }, action),
        drop: (sha: string): Promise<GitActionResult> => post(`drop`, { sha }, action),
        merge: (sha: string): Promise<GitActionResult> => post(`merge`, { sha }, action),
        rebase: (sha: string): Promise<GitActionResult> => post(`rebase`, { sha }, action),
        reset: (sha: string, mode: "soft" | "mixed" | "hard"): Promise<GitActionResult> => post(`reset`, { sha, mode }, action),
    };
}
