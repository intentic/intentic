import type { FileDiff, GitActionResult, GitCommit, GitCommitDiff, GitDiffSide } from "@intentic/sandbox-contract";
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
 * the previous box's history.
 *
 * Every call goes through `api.sandbox.rpc`, the daemon's contract as a typed client. What each verb answers is
 * the contract's declared output — the ref-only verbs (branch, tag) a bare ok, the sequence and HEAD-moving
 * verbs a GitActionResult whose `ok: false` is a clean-apply conflict the dialog reports rather than a throw.
 * That distinction used to be carried by a `parse` argument threaded through a shared `post` helper; it is now
 * simply each procedure's return type. */

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
        queryFn: ({ pageParam }) => api.sandbox.rpc.git.log({ repo: repo.value, limit: PAGE, skip: pageParam }),
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
    const commitFiles = (sha: string): Promise<GitCommitDiff> => api.sandbox.rpc.git.commitDiff({ repo: repo.value, sha });
    const commitFileDiff = (sha: string, path: string): Promise<FileDiff> => api.sandbox.rpc.git.commitFileDiff({ repo: repo.value, sha, path });
    // The working tree's counterpart, for row zero. `side` matters: a partially staged file's staged half
    // (index vs HEAD) and unstaged half (worktree vs index) are two different diffs of one path.
    const workingFileDiff = (path: string, side: GitDiffSide): Promise<FileDiff> => api.sandbox.rpc.git.fileDiff({ repo: repo.value, path, side });

    /* A write action moves refs and may move HEAD and the worktree with them. This invalidates what THIS
     * extension owns; every other surface converges on its own — the daemon's watcher pushes the worktree change
     * to the app's Changes review and file tree, and its ref push (api.workspace.onDidChangeRefs, wired in
     * extension.ts) brings back anything keyed off the refs. Reaching into the app's cache keys from here is
     * exactly the coupling this extension exists to not have. */
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: logKey.value });

    // Each verb below awaits its own procedure and then this, so the graph re-reads once the ref has actually
    // moved. Returned as the caller's value so a dialog can await the whole thing.
    const after = async <T>(call: Promise<T>): Promise<T> => {
        const result = await call;
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
        createBranch: (sha: string, name: string): Promise<unknown> => after(api.sandbox.rpc.git.createBranch({ repo: repo.value, sha, name })),
        createTag: (sha: string, name: string): Promise<unknown> => after(api.sandbox.rpc.git.createTag({ repo: repo.value, sha, name })),
        // A tag's other two verbs, so its pill is not a create-only affordance. `remote` is optional on delete:
        // absent means local only, which is what a tag that was never pushed wants.
        deleteTag: (name: string, remote?: string): Promise<unknown> =>
            after(api.sandbox.rpc.git.deleteTag({ repo: repo.value, name, ...(remote !== undefined ? { remote } : {}) })),
        pushTag: (name: string, remote: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.pushTag({ repo: repo.value, name, remote })),
        checkout: (ref: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.checkout({ repo: repo.value, ref })),
        cherryPick: (sha: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.cherryPick({ repo: repo.value, sha })),
        revert: (sha: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.revert({ repo: repo.value, sha })),
        drop: (sha: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.drop({ repo: repo.value, sha })),
        merge: (sha: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.merge({ repo: repo.value, sha })),
        rebase: (sha: string): Promise<GitActionResult> => after(api.sandbox.rpc.git.rebase({ repo: repo.value, sha })),
        reset: (sha: string, mode: "soft" | "mixed" | "hard"): Promise<GitActionResult> =>
            after(api.sandbox.rpc.git.reset({ repo: repo.value, sha, mode })),
    };
}
