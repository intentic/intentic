import type { FileDiffResponse, GitChangesResponse, RepoChanges } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandboxClient";
import { sandboxKey, useSandbox } from "../useSandbox";
import { resetEditBuffers } from "./useEditBuffers";

/* The Changes review — VSCode's SCM model over the workspace's real repos: the set is plain `git status`
 * (uncommitted work vs HEAD) per repo — "root" (the /work repo itself) plus every repo under repositories/ —
 * aggregated by the daemon's /git/changes. Commit (per repo or per file) makes a real commit on the repo's own
 * branch; discard restores the worktree from HEAD. No client-side watermark: the reviewed line IS the commit
 * boundary, so every browser and device agrees. Module-level singletons so the badge (shell), the panel, and
 * the workspace agree. */

const { reachable } = useSandbox();

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

const actionBusy = ref(false);
const actionError = ref<string | undefined>(undefined);

const fileDiff = (repo: string, path: string): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(`/git/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}`);

export function useChanges() {
    const query = useQuery({
        queryKey: sandboxKey(`git`, `changes`),
        queryFn: () => sandboxJson<GitChangesResponse>(`/git/changes`),
        enabled: reachable,
    });

    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.changes.length, 0));
    const hasChanges = computed(() => count.value > 0);
    const error = computed(() => (query.error.value ? query.error.value.message : undefined));

    // Commit the whole repo (no paths) or exactly `paths` — a real commit on the repo's branch.
    const commit = async (repo: string, message: string, paths?: readonly string[]): Promise<void> => {
        actionError.value = undefined;
        actionBusy.value = true;
        try {
            await sandboxJson(`/git/${encodeURIComponent(repo)}/commit`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ message, ...(paths !== undefined ? { paths } : {}) }),
            });
            await queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `changes`) });
        } catch (caught) {
            actionError.value = caught instanceof Error ? caught.message : `Commit failed.`;
        } finally {
            actionBusy.value = false;
        }
    };

    // Discard the whole repo's uncommitted work (no paths) or exactly `paths`: tracked content returns to
    // HEAD, untracked files are deleted.
    const discard = async (repo: string, paths?: readonly string[]): Promise<void> => {
        actionError.value = undefined;
        actionBusy.value = true;
        try {
            await sandboxJson(`/git/${encodeURIComponent(repo)}/discard`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(paths !== undefined ? { paths } : {}),
            });
            // The worktree changed underneath the UI: stale buffers would silently resurrect discarded files
            // on save. RAW prefix for the tree — its keys carry an "all"/"filtered" discriminator before the
            // appended sandbox id, so sandboxKey("workspace","tree") would NOT prefix-match them (see useSandbox).
            resetEditBuffers();
            await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
            await queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `changes`) });
        } catch (caught) {
            actionError.value = caught instanceof Error ? caught.message : `Discard failed.`;
        } finally {
            actionBusy.value = false;
        }
    };

    return {
        repos,
        count,
        hasChanges,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        commit,
        discard,
        actionBusy,
        actionError,
    };
}
