import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilityProbe, CapabilityRecommendation, CapabilitySummary, Marketplace } from "@intentic/api-contract";
import type { RemoteRefs } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { readIntenticLines } from "../../../lib/intenticStream";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { ENVIRONMENT, rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// The sandbox's unified capability manifest (.intentic/config/capabilities.json), read/written via the daemon's
// /capabilities routes. `add` streams its apply, like the provision flow. Presence of a kind means it's active (e.g.
// DevOps present shows its operator panels in the sidebar).

// A catalog form's answer as the daemon takes it: the form fills config by field, as strings, and the daemon's schema
// coerces and validates it, refusing what does not fit in its own words; checking it here would pre-empt those.
const asDeclared = (input: AddCapabilityInput): ProcedureInput<`capabilities.add`> => input as ProcedureInput<`capabilities.add`>;

// Named for the background loader (composables/prefetch), which warms the "+" view's list into this same entry.
export const capabilitiesKey = rpcKey(`capabilities.list`);

// Whole payload, not just `.capabilities`: the daemon also derives which capabilities the workspace asks for, which
// badges the catalog grid.
export const fetchCapabilities = (): Promise<{ capabilities: CapabilitySummary[]; recommendations: CapabilityRecommendation[] }> =>
    sandboxRpc.capabilities.list();

// Resolves a Claude Code plugin marketplace repo into installable entries: the daemon clones it, reads
// .claude-plugin/marketplace.json, and maps each entry onto plugin-capability config. POST so a private
// marketplace's token never rides a URL.
export const browseMarketplace = (url: string, token?: string): Promise<Marketplace> =>
    sandboxRpc.capabilities.marketplace({ url, ...(token !== undefined && token !== `` ? { token } : {}) });

// What a repository offers, so a form can pin a commit without anyone reading a sha off a web page: the daemon asks
// the remote with `git ls-remote`, cloning nothing. POST for the same reason as the marketplace read, the token.
export const readRemoteRefs = (url: string, token?: string, keeping?: string): Promise<RemoteRefs> =>
    sandboxRpc.capabilities.refs({
        url,
        ...(token === undefined || token === `` ? {} : { token }),
        // Names the connection whose stored token a VAULTED marker stands for; nothing to resolve on an add.
        ...(keeping === undefined || keeping === `` ? {} : { keeping }),
    });

// Dials the service the way the connection would and returns what it said (daemon's capabilities/probe.ts). Nothing
// is written, so this is a plain call, not a mutation: there's no cache to invalidate.
export const probeCapability = (input: AddCapabilityInput): Promise<CapabilityProbe> => sandboxRpc.capabilities.probe(asDeclared(input));

// Replaces just a capability's secret. Mutation only, no bundled useQuery, so a SecretField mount never refires
// /capabilities; only the capability list and secret inventory refresh.
export function useCapabilitySecret() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, value }: { id: string; value: string }) => sandboxRpc.capabilities.setSecret({ id, value }),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: capabilitiesKey }),
                queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
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
        queryKey: capabilitiesKey,
        queryFn: fetchCapabilities,
        refetchInterval: ({ state }) =>
            (state.data?.capabilities ?? []).some((capability) => capability.status.state === `pending`) ? PENDING_POLL_MS : false,
    });
    // Adding/removing a capability can recompose the environment overlay, so refresh the Environment tile too; a
    // platform capability also scaffolds rail panels, so refresh those as well.
    const invalidate = async (): Promise<void> => {
        // Three disjoint caches, no ordering, refetch them concurrently.
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: capabilitiesKey }),
            queryClient.invalidateQueries({ queryKey: ENVIRONMENT.of() }),
            queryClient.invalidateQueries({ queryKey: rpcKey(`panels.list`) }),
        ]);
    };

    // Reads the streamed apply, calling onLine per frame and throwing on an error frame; refreshes the list on completion.
    const add = async (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void): Promise<void> => {
        const lines = await sandboxRpc.capabilities.add(asDeclared(input)).catch((failure: unknown) => {
            throw failure instanceof SandboxHttpError ? new Error(failure.said.message ?? `Could not add the capability (${failure.status}).`) : failure;
        });
        for await (const line of readIntenticLines(lines)) {
            onLine?.(line);
            if (line[`kind`] === `error`) {
                throw new Error(typeof line[`message`] === `string` ? (line[`message`] as string) : `Apply failed.`);
            }
        }
        await invalidate();
    };

    const remove = useMutation({
        mutationFn: (id: string) => sandboxRpc.capabilities.remove({ id }),
        onSuccess: invalidate,
    });

    // Renames a connection; the daemon carries what the old name keyed and re-derives the rest, so a full invalidate
    // applies (a rename rewrites skills/env the same way an add does, and moves an extension's panels).
    const rename = useMutation({
        mutationFn: ({ id, to }: { id: string; to: string }) => sandboxRpc.capabilities.rename({ id, to }),
        onSuccess: invalidate,
    });

    // "Not needed": stops suggesting this tile until the workspace evidence changes; only the capability list
    // refreshes.
    const dismissRecommendation = useMutation({
        mutationFn: (entry: string) => sandboxRpc.capabilities.dismiss({ entry }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: capabilitiesKey }),
    });

    const capabilities = computed<CapabilitySummary[]>(() => query.data.value?.capabilities ?? []);
    const recommendations = computed<CapabilityRecommendation[]>(() => query.data.value?.recommendations ?? []);
    return {
        capabilities,
        // What the workspace asks for but isn't activated, by catalog tile rather than kind (several connectors share
        // `cli`); the evidence renders verbatim beside the claim.
        recommendationFor: (tile: string): CapabilityRecommendation | undefined =>
            recommendations.value.find((recommendation) => recommendation.entry === tile),
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
