import type { ConnectorContribution } from "@intentic/extension-api";
import { type ExtensionSummary, ExtensionsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandboxClient";
import { sandboxKey, useSandbox } from "../useSandbox";

/* The installed extensions (extension-kind capabilities resolved to their manifests) for the UI — the Sandbox
 * hub's Extensions tab. The extension host's boot does its own one-shot fetch of the same route (loader.ts);
 * this query exists for reactive rendering, not for loading code. */

const QUERY_KEY = sandboxKey(`extensions`);

export function useExtensions() {
    const { reachable } = useSandbox();
    const query = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => ExtensionsListSchema.parse(await sandboxJson(`/extensions`)).extensions,
        enabled: reachable,
    });
    const extensions = computed<ExtensionSummary[]>(() => query.data.value ?? []);
    // A cli provider's connector spec from the installed extensions' contributes.connectors — the data
    // capabilityEffects derives a cli card's secret/image effects from. Undefined until /extensions loads.
    const connectorOf = (provider: string): ConnectorContribution | undefined =>
        extensions.value
            .flatMap((extension) => extension.manifest.contributes?.connectors ?? [])
            .find((connector) => connector.provider === provider);
    return {
        extensions,
        connectorOf,
        // The list has actually arrived (or definitively failed) — gates decisions that must not fire against
        // the empty pre-fetch state, like bouncing an unknown /capabilities/<card> slug back to the grid.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
