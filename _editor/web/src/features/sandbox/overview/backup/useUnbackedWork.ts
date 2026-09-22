import type { GitRemoteRepo } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { GIT_REMOTE_REPOS } from "../../../../lib/queryKeys";
import { sandboxJson } from "../../client/sandboxClient";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { fetchWorkspaceTree } from "../../../workspace/explorer/useWorkspaceTree";
import { workspaceTreeKey } from "../../../workspace/explorer/workspaceTreeKey";

// Whether this workspace holds work that exists only here: files in it, and no repository in it pointing at a
// remote. Both halves matter — a fresh sandbox has no remote either, and telling somebody to connect a repository
// before they have written anything is a nag about nothing.

/* One lookup per repo, so this is polled on the slow clock a standing condition deserves, never on a change. */
const REMOTES_POLL_MS = 5 * 60_000;

export function useUnbackedWork() {
    const { query } = useSandboxQuery({
        queryKey: GIT_REMOTE_REPOS.of(),
        queryFn: async (): Promise<{ repos: GitRemoteRepo[] }> => sandboxJson(`/git/remote-repos`),
        refetchInterval: REMOTES_POLL_MS,
        staleTime: REMOTES_POLL_MS,
    });

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
    // An empty workspace is not unbacked work, it is no work; a tree that has not landed says nothing either way.
    const hasFiles = computed(() => (tree.data.value?.tree.length ?? 0) > 0);

    return {
        remotes,
        unbacked: computed(() => hasFiles.value && remotes.value?.length === 0),
    };
}
