import type { SharedConversation } from "@intentic/sandbox-contract/schemas/share";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { host } from "./host";

// Conversations published as pages, via the daemon's `share` procedures, the outbox's other half. Not part of
// `usePublic`: a share exists only because someone pressed Share, so this is the daemon's own index, moved by actions
// here rather than a filesystem read. Share pages are filtered out of the public file list for the same reason.

export function useShares() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.readKey(`share.list`);

    const { loaded } = api.sandbox.query({
        queryKey,
        queryFn: () => api.sandbox.rpc.share.list(),
        select: (answer): SharedConversation[] => answer.shares,
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    // Re-takes the snapshot behind an already-sent link: same id, same address, later state.
    const update = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.share.update({ id }),
        onSuccess: () => void invalidate(),
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.sandbox.rpc.share.remove({ id }),
        onSuccess: () => void invalidate(),
    });

    return {
        loaded,
        update,
        remove,
    };
}
