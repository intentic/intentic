import type { FileDiffResponse, GitActionResult, GitCommitDiffResponse, GitLogResponse } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* One repo's commit graph — the daemon's `git log --all` (newest-first, across every ref, so branch topology
 * shows). The log is the query; per-commit detail (the files a commit touched, then a file's before/after AT
 * the commit) loads lazily on selection, mirroring the Changes panel's fileDiff. Parameterized by a reactive
 * repo so a caller can swap repos and the query re-keys (like useAgentChanges by agent id). */

export function useGitLog(repo: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`git`, `log`, repo.value)),
        queryFn: () => sandboxJson<GitLogResponse>(`/git/${encodeURIComponent(repo.value)}/log`),
    });
    const commits = computed(() => query.data.value?.commits ?? []);
    const branch = computed(() => query.data.value?.branch);

    // The changed-files list for a commit (vs its first parent), then one file's HEAD-of-commit diff. Both keyed
    // to the current repo — the caller resolves them when a commit / file is clicked.
    const commitFiles = (sha: string): Promise<GitCommitDiffResponse> =>
        sandboxJson<GitCommitDiffResponse>(`/git/${encodeURIComponent(repo.value)}/commit-diff?sha=${encodeURIComponent(sha)}`);
    const commitFileDiff = (sha: string, path: string): Promise<FileDiffResponse> =>
        sandboxJson<FileDiffResponse>(
            `/git/${encodeURIComponent(repo.value)}/commit-file-diff?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`,
        );

    // A write action changes this repo's log (refs / commits) and may move HEAD + the worktree — invalidate the
    // log, the Changes review, the file tree, and the Checkpoints timeline (destructive ops auto-checkpoint) so
    // every surface reconverges.
    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `log`, repo.value) });
        await queryClient.invalidateQueries({ queryKey: [`git`, `changes`] });
        await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
        await queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    };
    // Every commit-context-menu action is a POST that then invalidates. Non-destructive refs (branch/tag) throw
    // on a git error (duplicate name) — the caller catches. The sequence + HEAD-moving ops return a
    // GitActionResult: `ok: false` is a clean-apply failure the caller surfaces, not a throw.
    const post = async <T>(action: string, body: Record<string, unknown>): Promise<T> => {
        const result = await sandboxJson<T>(`/git/${encodeURIComponent(repo.value)}/${action}`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(body),
        });
        await invalidate();
        return result;
    };
    const createBranch = (sha: string, name: string): Promise<unknown> => post(`branch`, { sha, name });
    const createTag = (sha: string, name: string): Promise<unknown> => post(`tag`, { sha, name });
    const checkout = (ref: string): Promise<GitActionResult> => post<GitActionResult>(`checkout`, { ref });
    const cherryPick = (sha: string): Promise<GitActionResult> => post<GitActionResult>(`cherry-pick`, { sha });
    const revert = (sha: string): Promise<GitActionResult> => post<GitActionResult>(`revert`, { sha });
    const drop = (sha: string): Promise<GitActionResult> => post<GitActionResult>(`drop`, { sha });
    const merge = (sha: string): Promise<GitActionResult> => post<GitActionResult>(`merge`, { sha });
    const rebase = (sha: string): Promise<GitActionResult> => post<GitActionResult>(`rebase`, { sha });
    const reset = (sha: string, mode: "soft" | "mixed" | "hard"): Promise<GitActionResult> => post<GitActionResult>(`reset`, { sha, mode });

    return {
        commits,
        branch,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        commitFiles,
        commitFileDiff,
        createBranch,
        createTag,
        checkout,
        cherryPick,
        revert,
        drop,
        merge,
        rebase,
        reset,
    };
}
