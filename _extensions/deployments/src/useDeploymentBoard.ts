import {
    type DeployAction,
    type DeployFixResponse,
    DeployFixResponseSchema,
    type DeployLogsResponse,
    DeployLogsResponseSchema,
    type DeployOverviewResponse,
    DeployOverviewResponseSchema,
    type DeployResource,
} from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* One Komodo connection's board, via the daemon's /komodo routes. The credential stays in the sandbox — the
 * browser never holds either half of the API key, which is why these routes exist rather than this composable
 * talking to Komodo directly.
 *
 * Faster than the rail's own poll: this serves someone actually watching a deploy land, where a minute is a
 * long time to wonder whether it worked. */
const POLL_MS = 10_000;

const post = (payload: Record<string, unknown>): RequestInit => ({
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(payload),
});

export function useDeploymentBoard(capability: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = computed(() => api.sandbox.key(`komodo-overview`, capability.value));
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey,
        queryFn: async (): Promise<DeployOverviewResponse> =>
            DeployOverviewResponseSchema.parse(await api.sandbox.json(`/komodo/${capability.value}/overview`)),
        enabled,
        refetchInterval: POLL_MS,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKey.value });

    const act = useMutation({
        mutationFn: (input: { resource: DeployResource; action: DeployAction }) =>
            api.sandbox.json(`/komodo/${capability.value}/action`, post({ kind: input.resource.kind, id: input.resource.id, action: input.action })),
        // Komodo's execute returns as soon as the operation is accepted, so the board it refetches may still
        // show the old state for a beat. That is honest — the poll above is what lands the new one — and it
        // beats optimistically drawing a state the container has not reached.
        onSuccess: invalidate,
    });

    // Bind a workspace repo to one of this Komodo's stacks (empty `stack` unlinks). Invalidates, because the
    // overview is what carries the link back — no optimistic copy to drift.
    const link = useMutation({
        mutationFn: (input: { repo: string; stack: string }) => api.sandbox.json(`/komodo/${capability.value}/link`, post(input)),
        onSuccess: invalidate,
    });

    const logs = useMutation({
        mutationFn: async (resource: DeployResource): Promise<DeployLogsResponse> =>
            DeployLogsResponseSchema.parse(
                await api.sandbox.json(`/komodo/${capability.value}/logs`, post({ kind: resource.kind, id: resource.id })),
            ),
    });

    // Starts an isolated agent seeded with the resource, its state and its log tail; resolves to its
    // conversation id, which is the fleet's card id — the view hands it to /agents?focus= and the board lands
    // on the card.
    const fix = useMutation({
        mutationFn: async (resource: DeployResource): Promise<DeployFixResponse> =>
            DeployFixResponseSchema.parse(await api.sandbox.json(`/komodo/${capability.value}/fix`, post({ kind: resource.kind, id: resource.id }))),
    });

    return {
        board: computed(() => query.data.value),
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true from mount until the FIRST response, INCLUDING the window where
        // `enabled` still gates the fetch on the sandbox handshake — the window in which isLoading is false
        // and an "nothing deployed" empty state would flash at someone whose board is about to arrive.
        isPending: query.isPending,
        act,
        link,
        logs,
        fix,
        refetch: query.refetch,
    };
}
