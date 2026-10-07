import { STARTER_REPO, type GitRemoteRepo } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { fetchWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";
import { workspaceTreeKey } from "../../../workspace/health/workspaceTreeKey";
import { holdsWork, onlyStarter, starterStateOf } from "./madeWork";

// Whether this workspace holds work that exists only here: work somebody made (madeWork.ts says what counts), and no
// repository in it pointing at a remote. Both halves matter — a fresh sandbox has no remote either, and telling somebody
// to connect a repository before they have made anything is a nag about nothing.

/* One lookup per repo, so this is polled on the slow clock a standing condition deserves, never on a change. */
const REMOTES_POLL_MS = 5 * 60_000;

export function useUnbackedWork() {
    const { query } = useSandboxQuery({ ...rpcQuery(`git.remoteRepos`), refetchInterval: REMOTES_POLL_MS, staleTime: REMOTES_POLL_MS });

    // Undefined while unread: "no repository has a remote" and "nobody has looked" are the difference between a
    // standing warning and a lie, and this one draws a warning.
    const remotes = computed<readonly GitRemoteRepo[] | undefined>(() => query.data.value?.repos);
    // The explorer's own key and fetcher, so this observes the tree that panel already has rather than fetching a
    // second copy — and rather than calling useWorkspaceTree, whose queryClient comes from inject() and so binds
    // the whole attention list to a setup context it is read outside of. Observed only once no repository has a
    // remote, the one case its answer decides: every window holds this list, and a live tree refetches per write burst.
    const { query: tree } = useSandboxQuery({
        queryKey: computed(() => workspaceTreeKey()),
        queryFn: fetchWorkspaceTree,
        enabled: computed(() => remotes.value?.length === 0),
    });
    // The top level is all that decides it; a tree that has not landed says nothing either way.
    const names = computed(() => tree.data.value?.tree.map((entry) => entry.name));

    // The starter site's own history, asked only while it is all there is to judge: one commit of log (a second means
    // somebody built on it) and the change list the Changes panel already holds, which the daemon pushes fresh.
    const starterOnly = computed(() => remotes.value?.length === 0 && onlyStarter(names.value));
    const { query: log } = useSandboxQuery({
        ...rpcQuery(`git.log`, { repo: STARTER_REPO, limit: 1 }),
        enabled: starterOnly,
        refetchInterval: REMOTES_POLL_MS,
    });
    const { query: changes } = useSandboxQuery({ ...rpcQuery(`git.changes`), enabled: starterOnly });
    const starter = computed(() =>
        starterStateOf({ ...(log.data.value === undefined ? {} : { data: log.data.value }), failed: log.isError.value }, changes.data.value),
    );

    return {
        remotes,
        unbacked: computed(() => remotes.value?.length === 0 && holdsWork(names.value, starter.value)),
    };
}
