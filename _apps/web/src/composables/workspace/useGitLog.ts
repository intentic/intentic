import type { FileDiffResponse, GitCommitDiffResponse, GitLogResponse } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
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

    return { commits, branch, loading: query.isFetching, error, refresh: query.refetch, commitFiles, commitFileDiff };
}
