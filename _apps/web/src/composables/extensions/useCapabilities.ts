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
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The sandbox's unified capability manifest (.intentic/capabilities.json), read/written via the daemon's
 * /capabilities routes. `add` STREAMS its apply (devops scaffolding, service provisioning) as ndjson, like the
 * provision flow. Presence of a kind = it's active (DevOps present ⇒ the intent + desired-state operator panels
 * appear in the sidebar). */

const QUERY_KEY = sandboxKey(`capabilities`);

// The whole payload, not just `.capabilities`: the daemon also derives which capabilities the WORKSPACE is
// asking for (a compose file in /work ⇒ docker), and the catalog grid badges those.
const fetchCapabilities = async (): Promise<{ capabilities: CapabilitySummary[]; recommendations: CapabilityRecommendation[] }> =>
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
            sandboxJson(`/capabilities/${encodeURIComponent(id)}/secret`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ value }),
            }),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
                queryClient.invalidateQueries({ queryKey: sandboxKey(`secrets`, `inventory`) }),
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
            queryClient.invalidateQueries({ queryKey: sandboxKey(`environment`) }),
            queryClient.invalidateQueries({ queryKey: sandboxKey(`panels`) }),
        ]);
    };

    // POST + read the streamed apply, calling onLine per ndjson frame; throws on an error frame. Refreshes the
    // list on completion so the new capability + its status appear.
    const add = async (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void): Promise<void> => {
        const response = await sandboxRequest(`/capabilities`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(input),
        });
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

    const capabilities = computed<CapabilitySummary[]>(() => query.data.value?.capabilities ?? []);
    const recommendations = computed<CapabilityRecommendation[]>(() => query.data.value?.recommendations ?? []);
    return {
        capabilities,
        // Presence of a kind = the user activated it (status reports its live health separately).
        hasCapability: (kind: string): boolean => capabilities.value.some((capability) => capability.kind === kind),
        // What the workspace asks for but isn't activated — the evidence path is rendered, so the card can say why.
        recommendationFor: (kind: string): CapabilityRecommendation | undefined =>
            recommendations.value.find((recommendation) => recommendation.kind === kind),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        add,
        remove,
    };
}
