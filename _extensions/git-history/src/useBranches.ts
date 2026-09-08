import { followCommandRun, type GitBranch, type GitRemoteBranch } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host.js";
import { useAsyncAction } from "./useAsyncAction.js";
import { groupBranches } from "./groupBranches.js";
import { useRefRefresh } from "./useRefRefresh.js";

// Interval between push-settled reads.
const PUSH_POLL_MS = 700;

// One repo's local branches for the switcher header; re-keys when `repo` changes. Every write refreshes both the branch
// list and the log, since both render ref decorations. Checkout no longer resets edit buffers: saves are
// baseline-guarded daemon-side, and the file viewer offers Reload.

export function useBranches(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();

    const branchesKey = computed(() => api.sandbox.key(`git-history`, `branches`, repo.value));
    const query = useQuery({
        queryKey: branchesKey,
        queryFn: () => api.sandbox.rpc.git.branches({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    // Ahead/behind and the checked-out branch move with refs, mostly the agent's doing rather than this switcher's.
    useRefRefresh(repo, [`branches`]);

    const branches = computed<readonly GitBranch[]>(() => query.data.value?.branches ?? []);
    const remotes = computed<readonly GitRemoteBranch[]>(() => query.data.value?.remotes ?? []);
    // `main` and `origin/main` render as one row instead of two peers to tell apart by a prefix.
    const groups = computed(() => groupBranches(branches.value, remotes.value));
    const current = computed(() => branches.value.find((branch) => branch.current));

    const { busy, error: actionError, run } = useAsyncAction();

    // Invalidates the branch list and the graph's ref decorations, two disjoint caches with no ordering between them.
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

    // `start` defaults to HEAD daemon-side. `checkout` makes this "new branch from here"; without it the branch is
    // created and HEAD stays put.
    const create = (name: string, options: { start?: string; checkout?: boolean } = {}): Promise<void> =>
        run(async () => {
            await api.sandbox.rpc.git.createBranchAt({ repo: repo.value, name, ...options });
            await invalidateRefs();
        }, `Could not create that branch.`);

    // Pushes the named branch, not HEAD; the daemon resolves the remote from its upstream. Followed as a run since the
    // pre-push hook can take minutes; a refusal is a caught reason, not a throw.
    const push = (name: string): Promise<void> =>
        run(async () => {
            await api.sandbox.rpc.git.push({ repo: repo.value, branch: name });
            const settled = await followCommandRun(() => api.sandbox.rpc.git.pushState({ repo: repo.value }), { intervalMs: PUSH_POLL_MS });
            if (settled === undefined || settled.status !== `passed`) {
                throw new Error(settled?.reason === undefined ? `Push was refused.` : `Push was refused: ${settled.reason}`);
            }
            await invalidateRefs();
        }, `Could not push that branch.`);

    // git refuses to delete a branch with commits nowhere else; `force` is the caller's deliberate retry after that
    // refusal.
    const remove = (name: string, force = false): Promise<void> =>
        run(
            async () => {
                await api.sandbox.rpc.git.deleteBranch({ repo: repo.value, name, force });
                await invalidateRefs();
            },
            force ? `Could not delete that branch.` : `Branch has unmerged commits, deleting it would lose them.`,
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
