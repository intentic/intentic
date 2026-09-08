import { type PublicFile, PublicListSchema, type PublishResult } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Workspace outbox via the daemon's /public routes, the file-shaped counterpart to `usePorts`: a file is exposed just
// by sitting in `public/`, no process needed. Observed via the manifest's `contributes.files` binding, pushed by the
// daemon's file watcher, so an agent's own writes there are seen too.

const jsonPost = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

export function usePublic() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`public`);

    const query = useQuery({
        queryKey,
        queryFn: async () => PublicListSchema.parse(await api.sandbox.json(`/public`)),
        enabled: computed(() => api.sandbox.reachable()),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // `path` is workspace-relative here and outbox-relative in unpublish, two path spaces, matching the routes.
    const publish = async (path: string): Promise<PublishResult> => {
        const result = await api.sandbox.json<PublishResult>(`/public/publish`, jsonPost({ path }));
        void invalidate();
        return result;
    };
    const unpublish = async (path: string): Promise<void> => {
        await api.sandbox.json(`/public/unpublish`, jsonPost({ path }));
        void invalidate();
    };

    const files = computed<PublicFile[]>(() => query.data.value?.files ?? []);
    return {
        files,
        // Outbox address; absent when the sandbox has no tunnel, which also signals nothing can be published.
        url: computed(() => query.data.value?.url),
        // Files actually reachable, not merely sitting in the directory.
        servedCount: computed(() => files.value.filter((file) => file.blocked === undefined).length),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        publish,
        unpublish,
    };
}
