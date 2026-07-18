import type { FileDiffResponse, GitChangesResponse, RepoChanges } from "@intentic-app/api-contract";
import { computed, watch } from "vue";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";
import { resetEditBuffers } from "./useEditBuffers";

/* The Changes review — VSCode's SCM model over the workspace's real repos: the set is plain `git status`
 * (uncommitted work vs HEAD) per repo — "root" (the /work repo itself) plus every repo under repositories/ —
 * aggregated by the daemon's /git/changes. Commit makes a real commit on the repo's own branch; discard
 * restores the worktree from HEAD. No client-side watermark: the reviewed line IS the commit boundary, so every
 * browser and device agrees. Module-level singletons so the badge (shell), the panel, and the workspace agree. */

// An agent turn ends when chat streaming falls — refresh the review set and the snapshot timeline so the badge
// and panels surface the turn's work without a manual refresh. Module scope (like sandboxScope.ts), NOT inside
// useChanges(): a watch installed from a component dies with that component's effect scope, and the /setup
// round-trip unmounts the shell that calls useChanges() first. Prefix match: the real keys are
// ["git","changes",<sandboxId ref>] / ["history","snapshots",<id>] (sandboxKey appends the id).
const { streaming } = useChat();
watch(streaming, (now, was) => {
    if (was && !now) {
        void queryClient.invalidateQueries({ queryKey: [`git`, `changes`] });
        void queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    }
});

// Batch mutations report through one shared busy span + error line, so N per-repo requests read as one action.
const { busy: actionBusy, error: actionError, run } = useAsyncAction();

const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(`/git/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`);

// One repo's slice of a batch action: an explicit `paths` subset, or the whole repo when `paths` is absent.
export interface RepoPaths {
    readonly repo: string;
    readonly paths?: readonly string[];
}

const invalidateChanges = (): Promise<void> => queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `changes`) });

// Commit a selection: git can't span repos, so each group is its own real commit on that repo's branch, all
// carrying the same message. A group with no `paths` commits the whole repo. One refresh for the whole batch.
const commitGroups = (groups: readonly RepoPaths[], message: string): Promise<void> =>
    run(async () => {
        for (const group of groups) {
            await sandboxJson(`/git/${encodeURIComponent(group.repo)}/commit`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ message, ...(group.paths !== undefined ? { paths: group.paths } : {}) }),
            });
        }
        await invalidateChanges();
    }, `Commit failed.`);

// Discard a selection: tracked content returns to HEAD, untracked files are deleted. A group with no `paths`
// discards the whole repo. Drop edit buffers + refresh the tree (the worktree changed under any open file).
const discardGroups = (groups: readonly RepoPaths[]): Promise<void> =>
    run(async () => {
        for (const group of groups) {
            await sandboxJson(`/git/${encodeURIComponent(group.repo)}/discard`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(group.paths !== undefined ? { paths: group.paths } : {}),
            });
        }
        // Stale buffers would silently resurrect discarded files on save. RAW prefix for the tree — its keys
        // carry an "all"/"filtered" discriminator before the appended sandbox id, so sandboxKey("workspace",
        // "tree") would NOT prefix-match them (see useSandbox).
        resetEditBuffers();
        await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
        await invalidateChanges();
    }, `Discard failed.`);

export function useChanges() {
    const { query, error } = useSandboxQuery({
        queryKey: sandboxKey(`git`, `changes`),
        queryFn: () => sandboxJson<GitChangesResponse>(`/git/changes`),
    });

    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.changes.length, 0));
    const hasChanges = computed(() => count.value > 0);

    return {
        repos,
        count,
        hasChanges,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        commitGroups,
        discardGroups,
        actionBusy,
        actionError,
    };
}
