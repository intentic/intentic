import type { GitBranch, GitBranchesResponse } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";
import { resetEditBuffers } from "./useEditBuffers";

/* One repo's local branches — the graph header's switcher. Parameterized by a reactive repo so the query
 * re-keys when the caller swaps repos (the same shape useGitLog takes).
 *
 * Checking out is the only verb here that touches files, so it is the only one that drops edit buffers and
 * refreshes the tree; creating and deleting a branch move refs alone. Every verb refreshes the branch list AND
 * the log, because both render ref decorations. */

export function useBranches(repo: Ref<string>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`git`, `branches`, repo.value)),
        queryFn: () => sandboxJson<GitBranchesResponse>(`/git/${encodeURIComponent(repo.value)}/branches`),
    });
    const branches = computed<readonly GitBranch[]>(() => query.data.value?.branches ?? []);
    const current = computed(() => branches.value.find((branch) => branch.current));

    const { busy, error: actionError, run } = useAsyncAction();

    const post = <T>(action: string, body: Record<string, unknown>): Promise<T> =>
        sandboxJson<T>(`/git/${encodeURIComponent(repo.value)}/${action}`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(body),
        });

    // Ref-only refresh: the branch list and the graph's decorations. Four disjoint caches, no ordering.
    const invalidateRefs = (): Promise<unknown> =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `branches`, repo.value) }),
            queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `log`, repo.value) }),
            queryClient.invalidateQueries({ queryKey: [`git`, `changes`] }),
        ]);

    // A checkout swapped the worktree under any open file — stale buffers would write the OTHER branch's
    // content back on save, so they go before anything re-reads.
    const invalidateWorktree = async (): Promise<void> => {
        resetEditBuffers();
        await Promise.all([
            invalidateRefs(),
            queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }),
            queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] }),
        ]);
    };

    const checkout = (name: string): Promise<void> =>
        run(async () => {
            await post(`checkout`, { ref: name });
            await invalidateWorktree();
        }, `Checkout failed. Commit, stage or discard your changes first.`);

    // `start` defaults to HEAD daemon-side. `checkout` makes this "new branch from here", the switcher's
    // primary gesture; without it the branch is created and HEAD stays put.
    const create = (name: string, options: { start?: string; checkout?: boolean } = {}): Promise<void> =>
        run(async () => {
            await post(`branches`, { name, ...options });
            await (options.checkout === true ? invalidateWorktree() : invalidateRefs());
        }, `Could not create that branch.`);

    // git refuses to drop a branch whose commits are nowhere else; `force` is the caller's deliberate retry
    // after seeing that refusal, never something this composable decides on its own.
    const remove = (name: string, force = false): Promise<void> =>
        run(
            async () => {
                await post(`branches/delete`, { name, force });
                await invalidateRefs();
            },
            force ? `Could not delete that branch.` : `Branch has unmerged commits — deleting it would lose them.`,
        );

    return { branches, current, loading: query.isFetching, error, busy, actionError, refresh: query.refetch, checkout, create, remove };
}
