import type { PublishResult } from "@intentic/sandbox-contract/schemas/public";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Workspace outbox via the daemon's `public` procedures, the file-shaped counterpart to `usePorts`: a file is exposed
// just by sitting in `public/`, no process needed. Observed via the manifest's `contributes.files` binding, pushed by
// the daemon's file watcher under the name `public`, which the host turns into this read's key (the shell's outbox
// shares it), so an agent's own writes there are seen too.

export function usePublic() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.readKey(`public.list`);

    const { query, loaded } = api.sandbox.query({
        queryKey,
        queryFn: () => api.sandbox.rpc.public.list(),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // `path` is workspace-relative here and outbox-relative in unpublish, two path spaces, matching the routes.
    const publish = async (path: string): Promise<PublishResult> => {
        const result = await api.sandbox.rpc.public.publish({ path });
        void invalidate();
        return result;
    };
    const unpublish = async (path: string): Promise<void> => {
        await api.sandbox.rpc.public.unpublish({ path });
        void invalidate();
    };

    return {
        // Outbox address; absent when the sandbox has no tunnel, which also signals nothing can be published.
        url: computed(() => query.data.value?.url),
        // The listing itself, for the view's <Await>: waiting while the sandbox wakes, never an empty outbox.
        loaded,
        publish,
        unpublish,
    };
}
