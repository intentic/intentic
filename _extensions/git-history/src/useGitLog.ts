import type { FileDiff, GitActionResult, GitCommit, GitCommitDiff, GitDiffSide } from "@intentic/sandbox-contract";
import { useInfiniteQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useRefRefresh } from "./useRefRefresh.js";

// One repo's commit graph via the daemon's `git log --all` (newest-first, across every ref). Per-commit detail (files
// touched, then a file's before/after) loads lazily on selection. The cache key is scoped to the active sandbox via
// `api.sandbox.key`, so switching sandboxes can't show stale history.

export function useGitLog(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    // Page size mirrors the daemon's own default: already more than fits on a screen, so the rest is scrolling.
    const PAGE = 300;
    const logKey = computed(() => api.sandbox.key(`git-history`, `log`, repo.value));
    const query = useInfiniteQuery({
        queryKey: logKey,
        queryFn: ({ pageParam }) => api.sandbox.rpc.git.log({ repo: repo.value, limit: PAGE, skip: pageParam }),
        initialPageParam: 0,
        // `hasMore` comes from the daemon asking for one commit more than it returned, a fact rather than a guess.
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
        enabled: computed(() => api.sandbox.reachable()),
    });

    // A ref moving in this repo (agent commit, land, rebase) leaves the log stale with nothing local to invalidate.
    useRefRefresh(repo, [`log`]);

    const commits = computed<readonly GitCommit[]>(() => query.data.value?.pages.flatMap((page) => page.commits) ?? []);
    const branch = computed(() => query.data.value?.pages[0]?.branch);

    // Changed files for a commit (vs its first parent), then one file's diff at that commit; both keyed to the current
    // repo.
    const commitFiles = (sha: string): Promise<GitCommitDiff> => api.sandbox.rpc.git.commitDiff({ repo: repo.value, sha });
    const commitFileDiff = (sha: string, path: string): Promise<FileDiff> => api.sandbox.rpc.git.commitFileDiff({ repo: repo.value, sha, path });
    // The working tree's counterpart for row zero; `side` matters since a partially staged file's staged half (index vs
    // HEAD) and unstaged half (worktree vs index) differ.
    const workingFileDiff = (path: string, side: GitDiffSide): Promise<FileDiff> => api.sandbox.rpc.git.fileDiff({ repo: repo.value, path, side });

    // Invalidates only what this extension owns; other surfaces (file tree, Changes panel) converge on their own via
    // the daemon's watcher and ref pushes.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: logKey.value });

    // Awaits the call, then re-reads once the ref has moved; returned so a caller can await the whole thing.
    const after = async <T>(call: Promise<T>): Promise<T> => {
        const result = await call;
        await invalidate();
        return result;
    };
    return {
        commits,
        branch,
        loading: query.isFetching,
        // Separate from `loading`, so fetching the next page doesn't make the whole graph look like it's reloading.
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
        // A tag's other two verbs, so its pill isn't create-only; `remote` absent on delete means local-only.
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
