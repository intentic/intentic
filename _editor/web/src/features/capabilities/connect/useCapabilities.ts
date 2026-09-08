import type { AddCapabilityInput } from "@intentic/capability-catalog";
import {
    CapabilitiesListSchema,
    type CapabilityProbe,
    CapabilityProbeSchema,
    type CapabilityRecommendation,
    type CapabilitySummary,
    type Marketplace,
    MarketplaceSchema,
} from "@intentic/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { CAPABILITIES, ENVIRONMENT, PANELS, SECRETS_INVENTORY } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// The sandbox's unified capability manifest (.intentic/config/capabilities.json), read/written via the daemon's
// /capabilities routes. `add` streams its apply as ndjson, like the provision flow. Presence of a kind means it's
// active (e.g. DevOps present shows its operator panels in the sidebar).

const QUERY_KEY = CAPABILITIES.of();

// Named for the background loader (composables/prefetch), which warms the "+" view's list into this same entry.
export const capabilitiesKey = QUERY_KEY;

// Whole payload, not just `.capabilities`: the daemon also derives which capabilities the workspace asks for, which
// badges the catalog grid.
export const fetchCapabilities = async (): Promise<{ capabilities: CapabilitySummary[]; recommendations: CapabilityRecommendation[] }> =>
    CapabilitiesListSchema.parse(await sandboxJson(`/capabilities`));

// Resolves a Claude Code plugin marketplace repo into installable entries: the daemon clones it, reads
// .claude-plugin/marketplace.json, and maps each entry onto plugin-capability config. POST so a private
// marketplace's token never rides a URL.
export const browseMarketplace = async (url: string, token?: string): Promise<Marketplace> =>
    MarketplaceSchema.parse(
        await sandboxJson(`/capabilities/marketplace`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ url, ...(token !== undefined && token !== `` ? { token } : {}) }),
        }),
    );

// Dials the service the way the connection would and returns what it said (daemon's capabilities/probe.ts). Nothing
// is written, so this is a plain call, not a mutation: there's no cache to invalidate.
export const probeCapability = async (input: AddCapabilityInput): Promise<CapabilityProbe> =>
    CapabilityProbeSchema.parse(await sandboxJson(`/capabilities/probe`, jsonBody(`POST`, input)));

// Replaces just a capability's secret. Mutation only, no bundled useQuery, so a SecretField mount never refires
// /capabilities; only the capability list and secret inventory refresh.
export function useCapabilitySecret() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, value }: { id: string; value: string }) =>
            sandboxJson(`/capabilities/${encodeURIComponent(id)}/secret`, jsonBody(`POST`, { value })),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
                queryClient.invalidateQueries({ queryKey: SECRETS_INVENTORY.of() }),
            ]);
        },
    });
}

// Polls only while a capability is pending, since that means waiting on something outside the browser (a phone
// linking, a login finishing) this app isn't told about. Three seconds because the thing shown is often a code the
// reader is copying, and a stale one looks live.
const PENDING_POLL_MS = 3_000;

export function useCapabilities() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: fetchCapabilities,
        refetchInterval: ({ state }) =>
            (state.data?.capabilities ?? []).some((capability) => capability.status.state === `pending`) ? PENDING_POLL_MS : false,
    });
    // Adding/removing a capability can recompose the environment overlay, so refresh the Environment card too; a
    // platform capability also scaffolds rail panels, so refresh those as well.
    const invalidate = async (): Promise<void> => {
        // Three disjoint caches, no ordering, refetch them concurrently.
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ENVIRONMENT.of() }),
            queryClient.invalidateQueries({ queryKey: PANELS.of() }),
        ]);
    };

    // POSTs and reads the streamed apply, calling onLine per ndjson frame and throwing on an error frame; refreshes the
    // list on completion.
    const add = async (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void): Promise<void> => {
        const response = await sandboxRequest(`/capabilities`, jsonBody(`POST`, input));
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { message?: string } | null;
            throw new Error(detail?.message ?? `Could not add the capability (${response.status}).`);
        }
        for await (const line of readIntenticLines(response.body)) {
            onLine?.(line);
            if (line[`kind`] === `error`) {
                throw new Error(typeof line[`message`] === `string` ? (line[`message`] as string) : `Apply failed.`);
            }
        }
        await invalidate();
    };

    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/capabilities/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    // Renames a connection; the daemon carries what the old name keyed and re-derives the rest, so a full invalidate
    // applies (a rename rewrites skills/env the same way an add does, and moves an extension's panels).
    const rename = useMutation({
        mutationFn: ({ id, to }: { id: string; to: string }) =>
            sandboxJson(`/capabilities/${encodeURIComponent(id)}/rename`, jsonBody(`POST`, { to })),
        onSuccess: invalidate,
    });

    // "Not needed": stops suggesting this card until the workspace evidence changes; only the capability list
    // refreshes.
    const dismissRecommendation = useMutation({
        mutationFn: (card: string) => sandboxJson(`/capabilities/recommendations/${encodeURIComponent(card)}`, { method: `DELETE` }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    });

    const capabilities = computed<CapabilitySummary[]>(() => query.data.value?.capabilities ?? []);
    const recommendations = computed<CapabilityRecommendation[]>(() => query.data.value?.recommendations ?? []);
    return {
        capabilities,
        // Presence of a kind = the user activated it (status reports its live health separately).
        hasCapability: (kind: string): boolean => capabilities.value.some((capability) => capability.kind === kind),
        // What the workspace asks for but isn't activated, by catalog card rather than kind (several connectors share
        // `cli`); the evidence renders verbatim beside the claim.
        recommendationFor: (card: string): CapabilityRecommendation | undefined =>
            recommendations.value.find((recommendation) => recommendation.card === card),
        // Whether the manifest has arrived or definitively failed: the rail's half of "absent vs. merely late" (see
        // usePanels.settled).
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        add,
        remove,
        rename,
        dismissRecommendation,
    };
}
