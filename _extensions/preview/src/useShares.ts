import { type SharedConversation, ShareListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Conversations published as pages, via the daemon's /share routes, the outbox's other half. Not part of `usePublic`: a
// share exists only because someone pressed Share, so this is the daemon's own index, moved by actions here rather than
// a filesystem read. Share pages are filtered out of the public file list for the same reason.

const post = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

export function useShares() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`shares`);

    const query = useQuery({
        queryKey,
        queryFn: async () => ShareListSchema.parse(await api.sandbox.json(`/share`)),
        enabled: computed(() => api.sandbox.reachable()),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // Re-takes the snapshot behind an already-sent link: same id, same address, later state.
    const update = useMutation({
        mutationFn: async (id: string) => api.sandbox.json<SharedConversation>(`/share/update`, post({ id })),
        onSuccess: () => void invalidate(),
    });
    const remove = useMutation({
        mutationFn: async (id: string) => api.sandbox.json(`/share/remove`, post({ id })),
        onSuccess: () => void invalidate(),
    });

    return {
        shares: computed<SharedConversation[]>(() => query.data.value?.shares ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        update,
        remove,
    };
}
