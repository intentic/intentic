import type { GitBranch, GitRemoteBranch } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { groupBranches } from "./groupBranches.js";
import { useRefRefresh } from "./useRefRefresh.js";

/* One repo's local branches — the graph header's switcher. Parameterized by a reactive repo so the query
 * re-keys when the caller swaps repos (the same shape useGitLog takes).
 *
 * Every verb refreshes the branch list AND the log, because both render ref decorations. Nothing here drops the
 * app's edit buffers on checkout the way the in-app predecessor did: a save is guarded by its baseline hash
 * daemon-side (the write 409s when the file moved under it) and the file viewer keeps an unsaved buffer and
 * offers Reload, so the swap is already safe. What the reset bought was quiet — no "changed on disk" notice per
 * file — and that belongs on the ref push, where it also covers an agent switching branches in a terminal. */

export function useBranches(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const branchesKey = computed(() => api.sandbox.key(`git-history`, `branches`, repo.value));
    const query = useQuery({
        queryKey: branchesKey,
        queryFn: () => api.sandbox.rpc.git.branches({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    // Ahead/behind and the checked-out branch both move with the refs, and most of those moves are the
    // agent's rather than this switcher's.
    useRefRefresh(repo, [`branches`]);

    const branches = computed<readonly GitBranch[]>(() => query.data.value?.branches ?? []);
    const remotes = computed<readonly GitRemoteBranch[]>(() => query.data.value?.remotes ?? []);
    // `main` and `origin/main` are one line of work; the switcher shows one row for them rather than two peers
    // the reader has to tell apart by a prefix. See groupBranches for why they pair by name.
    const groups = computed(() => groupBranches(branches.value, remotes.value));
    const current = computed(() => branches.value.find((branch) => branch.current));

    const { busy, error: actionError, run } = useAsyncAction();

    // The branch list and the graph's decorations — two disjoint caches, no ordering between them.
    const invalidateRefs = (): Promise<unknown> =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: branchesKey.value }),
            queryClient.invalidateQueries({ queryKey: api.sandbox.key(`git-history`, `log`, repo.value) }),
        ]);

    const checkout = (name: string): Promise<void> =>
        run(async () => {
            await api.sandbox.rpc.git.checkout({ repo: repo.value, ref: name });
            await invalidateRefs();
        }, `Checkout failed. Commit, stage or discard your changes first.`);

    // `start` defaults to HEAD daemon-side. `checkout` makes this "new branch from here", the switcher's
    // primary gesture; without it the branch is created and HEAD stays put.
    const create = (name: string, options: { start?: string; checkout?: boolean } = {}): Promise<void> =>
        run(async () => {
            await api.sandbox.rpc.git.createBranchAt({ repo: repo.value, name, ...options });
            await invalidateRefs();
        }, `Could not create that branch.`);

    /* Publish a branch. Named explicitly rather than pushing HEAD, because the pill the user right-clicked is the
     * branch they meant — which is not always the one checked out. The daemon resolves which REMOTE from that
     * branch's own upstream (or the configured default when it has none), so this never has to guess.
     *
     * A rejected push is a value, not a throw: "no upstream yet", "would not fast-forward" and "no permission"
     * are all ordinary answers a pill should report rather than blow up on. */
    const push = (name: string): Promise<void> =>
        run(async () => {
            const result = await api.sandbox.rpc.git.push({ repo: repo.value, branch: name });
            if (!result.ok) {
                throw new Error(result.reason === undefined ? `Push was rejected.` : `Push was rejected: ${result.reason}`);
            }
            await invalidateRefs();
        }, `Could not push that branch.`);

    // git refuses to drop a branch whose commits are nowhere else; `force` is the caller's deliberate retry
    // after seeing that refusal, never something this composable decides on its own.
    const remove = (name: string, force = false): Promise<void> =>
        run(
            async () => {
                await api.sandbox.rpc.git.deleteBranch({ repo: repo.value, name, force });
                await invalidateRefs();
            },
            force ? `Could not delete that branch.` : `Branch has unmerged commits — deleting it would lose them.`,
        );

    return {
        branches,
        remotes,
        groups,
        current,
        loading: query.isFetching,
        error: computed(() => query.error.value?.message),
        busy,
        actionError,
        refresh: (): Promise<unknown> => invalidateRefs(),
        checkout,
        create,
        push,
        remove,
    };
}
