import type { AgentRunChoice } from "@intentic/extension-ui";
import { runPickOf } from "@intentic/sandbox-contract";
import {
    type DeployAction,
    type DeployFixResponse,
    DeployFixResponseSchema,
    type DeployLogsResponse,
    DeployLogsResponseSchema,
    DEPLOYMENTS_BASE,
    type DeployOverviewResponse,
    DeployOverviewResponseSchema,
    type DeployResource,
} from "./contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// One Komodo connection's board, via the daemon's /komodo routes: the browser never holds the API key, which is why
// these routes exist instead of calling Komodo directly. Polls faster than the rail's own badge, for someone actually
// watching a deploy land.
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
            DeployOverviewResponseSchema.parse(await api.sandbox.json(`${DEPLOYMENTS_BASE}/komodo/${capability.value}/overview`)),
        enabled,
        refetchInterval: POLL_MS,
    });
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: queryKey.value });

    const act = useMutation({
        mutationFn: (input: { resource: DeployResource; action: DeployAction }) =>
            api.sandbox.json(
                `${DEPLOYMENTS_BASE}/komodo/${capability.value}/action`,
                post({ kind: input.resource.kind, id: input.resource.id, action: input.action }),
            ),
        // Execute returns as soon as accepted; the refetch may briefly show stale state until the next poll.
        onSuccess: invalidate,
    });

    // Binds a repo to a stack (empty `stack` unlinks); invalidates since the overview carries the link back.
    const link = useMutation({
        mutationFn: (input: { repo: string; stack: string }) => api.sandbox.json(`${DEPLOYMENTS_BASE}/komodo/${capability.value}/link`, post(input)),
        onSuccess: invalidate,
    });

    const logs = useMutation({
        mutationFn: async (resource: DeployResource): Promise<DeployLogsResponse> =>
            DeployLogsResponseSchema.parse(
                await api.sandbox.json(`${DEPLOYMENTS_BASE}/komodo/${capability.value}/logs`, post({ kind: resource.kind, id: resource.id })),
            ),
    });

    // Starts an isolated agent seeded with the resource and its logs; resolves to the conversation/card id.
    const fix = useMutation({
        mutationFn: async ({ resource, pick }: { resource: DeployResource; pick?: AgentRunChoice | undefined }): Promise<DeployFixResponse> =>
            DeployFixResponseSchema.parse(
                await api.sandbox.json(
                    `${DEPLOYMENTS_BASE}/komodo/${capability.value}/fix`,
                    post({
                        kind: resource.kind,
                        id: resource.id,
                        // The knobs ride with the pair: the daemon fills a pinned entry's in only for a run that
                        // named no model, so a pick without them drops to the provider's own defaults.
                        ...(pick === undefined ? {} : { pick: runPickOf(pick) }),
                    }),
                ),
            ),
    });

    return {
        board: computed(() => query.data.value),
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true through the handshake window too, where isLoading would flash an empty state.
        isPending: query.isPending,
        act,
        link,
        logs,
        fix,
        refetch: query.refetch,
    };
}
