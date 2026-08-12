import { type AddCapabilityInput } from "@intentic-app/capability-catalog";
import {
    CapabilitiesListSchema,
    type CapabilityRecommendation,
    type CapabilitySummary,
    type Marketplace,
    MarketplaceSchema,
} from "@intentic-app/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { readIntenticLines } from "../intenticStream";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { CAPABILITIES, ENVIRONMENT, PANELS, SECRETS_INVENTORY } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The sandbox's unified capability manifest (.intentic/capabilities.json), read/written via the daemon's
 * /capabilities routes. `add` STREAMS its apply (devops scaffolding, service provisioning) as ndjson, like the
 * provision flow. Presence of a kind = it's active (DevOps present ⇒ the intent + desired-state operator panels
 * appear in the sidebar). */

const QUERY_KEY = CAPABILITIES.of();

// Named for the background loader (composables/prefetch), which warms the "+" view's list into the same entry
// this reads.
export const capabilitiesKey = QUERY_KEY;

// The whole payload, not just `.capabilities`: the daemon also derives which capabilities the WORKSPACE is
// asking for (a compose file in /work ⇒ docker), and the catalog grid badges those.
export const fetchCapabilities = async (): Promise<{ capabilities: CapabilitySummary[]; recommendations: CapabilityRecommendation[] }> =>
    CapabilitiesListSchema.parse(await sandboxJson(`/capabilities`));

// Resolve a Claude Code plugin marketplace repo into installable entries — the daemon clones it, reads its
// .claude-plugin/marketplace.json, and maps each entry's source onto plugin-capability config. POST so the
// optional token for a private marketplace never rides a URL.
export const browseMarketplace = async (url: string, token?: string): Promise<Marketplace> =>
    MarketplaceSchema.parse(
        await sandboxJson(`/capabilities/marketplace`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ url, ...(token !== undefined && token !== `` ? { token } : {}) }),
        }),
    );

// Replace just a capability's secret (the Sandbox Secrets tab's pencil on a capability row). Mutation only — no
// useQuery bundled, so a SecretField mount never refires /capabilities (the observer-refetch problem the
// useSecrets doc comment describes). A secret edit can't recompose the environment, so only the capability
// list + secret inventory refresh.
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

export function useCapabilities() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchCapabilities });
    // Adding/removing a capability can recompose the environment overlay (image fragments) — refresh the
    // Environment card alongside the list so "Pending rebuild" shows up immediately. A platform capability
    // (devops/monorepo) also scaffolds repos that appear as rail panels, so refresh the panels list too.
    const invalidate = async (): Promise<void> => {
        // Three disjoint caches, no ordering — refetch them concurrently.
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ENVIRONMENT.of() }),
            queryClient.invalidateQueries({ queryKey: PANELS.of() }),
        ]);
    };

    // POST + read the streamed apply, calling onLine per ndjson frame; throws on an error frame. Refreshes the
    // list on completion so the new capability + its status appear.
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

    // Give a connection a different name. The daemon carries what the old name keyed (a signed-in browser
    // profile, a machine's enrollment) and re-derives the rest, so the full invalidate applies: the skills and
    // env a rename rewrites are the same ones an add composes, and a renamed extension moves its panels.
    const rename = useMutation({
        mutationFn: ({ id, to }: { id: string; to: string }) =>
            sandboxJson(`/capabilities/${encodeURIComponent(id)}/rename`, jsonBody(`POST`, { to })),
        onSuccess: invalidate,
    });

    // "Not needed": stop suggesting this card until the workspace evidence behind it changes. Only the catalog
    // moves, so only the capability list is refreshed — nothing is installed, removed or recomposed.
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
        // What the workspace asks for but isn't activated, by CATALOG CARD — github, gitlab and every other
        // connector share the `cli` kind, so a kind would badge all of them at once. The evidence is rendered
        // verbatim beside the claim, so the card says why rather than asking to be trusted.
        recommendationFor: (card: string): CapabilityRecommendation | undefined =>
            recommendations.value.find((recommendation) => recommendation.card === card),
        // The manifest has actually arrived (or definitively failed) — the rail's other half of "is this tile
        // absent or merely late", alongside the panels list (see usePanels.settled).
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
