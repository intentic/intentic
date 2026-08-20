import { type SharedConversation, ShareListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* CONVERSATIONS PUBLISHED AS PAGES, via the daemon's /share routes, the outbox's other half.
 *
 * Deliberately NOT part of `usePublic`, which observes a directory: the outbox is an ordinary folder, so that
 * query has to answer to whatever an agent writes into it, and it is pushed by the file watcher for exactly
 * that reason. A share is the opposite kind of thing, it exists because someone pressed Share, and the list
 * of them is the daemon's own index rather than a reading of the filesystem. So this query moves when an
 * action moves it, and nothing else can put a row in it.
 *
 * (The pages themselves are filtered OUT of the public file list for the same reason: they are managed here,
 * with a title and a date and an Update, not as a hundred rows of assets.) */

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
    // Re-take the snapshot behind a link that has already been sent, same id, same address, later state.
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
