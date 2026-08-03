import { type GitActionResult, GitActionResultSchema, type GitCommitDiff, GitCommitDiffSchema, type StashEntry, StashListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { useRefRefresh } from "./useRefRefresh.js";

/* THIS REPO'S STASHES — work set aside without committing it.
 *
 * Shown in the graph because a stash entry IS a commit: it has a sha, a time, a subject and a diff, and its
 * first parent is the commit it was taken on. Until this existed, a `git stash` in a terminal made the work
 * invisible everywhere in this workspace — not listed, not diffable, not recoverable except by remembering it
 * was there.
 *
 * `ref` is POSITIONAL (`stash@{0}`, `stash@{1}`…), and dropping one renumbers the rest — so every verb here
 * invalidates the list rather than assuming the refs it was rendered from still mean the same entries. */

const encode = (value: string): string => encodeURIComponent(value);

export function useStashes(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const key = computed(() => api.sandbox.key(`git-history`, `stashes`, repo.value));
    const query = useQuery({
        queryKey: key,
        queryFn: async () => StashListSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/stashes`)),
        enabled: computed(() => api.sandbox.reachable()),
    });
    // `refs/stash` is a ref like any other, so stashing in a terminal arrives on the same push as a commit.
    useRefRefresh(repo, [`stashes`]);

    const stashes = computed<readonly StashEntry[]>(() => query.data.value?.stashes ?? []);
    const { busy, error: actionError, run } = useAsyncAction();

    const files = async (ref: string): Promise<GitCommitDiff> =>
        GitCommitDiffSchema.parse(await api.sandbox.json(`/git/${encode(repo.value)}/stash-diff?ref=${encode(ref)}`));

    // Applying or popping rewrites the worktree, and dropping changes the list — all three invalidate both, since
    // a renumbered list rendered against old refs would act on the wrong entry.
    const post = async (path: string, body: Record<string, unknown>): Promise<GitActionResult> => {
        const result = GitActionResultSchema.parse(
            await api.sandbox.json(`/git/${encode(repo.value)}/${path}`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(body),
            }),
        );
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: key.value }),
            queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `working`) }),
        ]);
        return result;
    };

    return {
        stashes,
        files,
        busy,
        actionError,
        // `pop` puts it back and consumes the entry; `apply` keeps it. A conflict comes back as `ok: false` with
        // the entry intact — the work is never lost, so it is worth saying rather than throwing.
        apply: (ref: string, pop: boolean): Promise<void> =>
            run(async () => {
                const result = await post(`stash/apply`, { ref, pop });
                if (!result.ok) {
                    throw new Error(`Could not apply cleanly — resolve the conflict in the Changes panel. The stash is still there.`);
                }
            }, `Could not apply that stash.`),
        drop: (ref: string): Promise<void> => run(async () => void (await post(`stash/drop`, { ref })), `Could not drop that stash.`),
    };
}
