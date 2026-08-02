import { type PublicFile, PublicListSchema, type PublishResult } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The workspace outbox, via the daemon's /public routes — the file-shaped counterpart to `usePorts`. A port is
 * exposed by forwarding a running server; a file is exposed by being in `public/`, which needs no process at
 * all and is why this list can be non-empty while nothing is running.
 *
 * Polled rather than pushed, and for a sharper reason than the Ports view has: the outbox is an ORDINARY
 * directory, so an agent that writes a build output into it publishes it without going through `publish` at
 * all. The poll is what makes the view an observation of the filesystem instead of a log of this UI's actions. */

const POLL_MS = 4000;

const jsonPost = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

export function usePublic() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`public`);

    const query = useQuery({
        queryKey,
        queryFn: async () => PublicListSchema.parse(await api.sandbox.json(`/public`)),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // `path` is WORKSPACE-relative here and OUTBOX-relative in unpublish — two path spaces, matching the routes.
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
        // The outbox's own address, absent on a sandbox with no tunnel — which is also the honest signal that
        // nothing here can be published at all.
        url: computed(() => query.data.value?.url),
        // What is actually reachable, as opposed to what is merely sitting in the directory.
        servedCount: computed(() => files.value.filter((file) => file.blocked === undefined).length),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        publish,
        unpublish,
    };
}
