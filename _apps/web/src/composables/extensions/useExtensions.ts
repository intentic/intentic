import type { ConnectorContribution } from "@intentic/extension-api";
import { type ExtensionSummary, ExtensionsListSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The installed extensions (extension-kind capabilities resolved to their manifests) for the UI — the Sandbox
 * hub's Extensions tab. The extension host's boot does its own one-shot fetch of the same route (loader.ts);
 * this query exists for reactive rendering, not for loading code. */

const QUERY_KEY = sandboxKey(`extensions`);

export function useExtensions() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => ExtensionsListSchema.parse(await sandboxJson(`/extensions`)).extensions,
    });
    const extensions = computed<ExtensionSummary[]>(() => query.data.value ?? []);
    // Flip one extension's switch and re-read the list. The daemon converges its own half (declared processes
    // stop/start, connectors and listener providers drop out of every subsequent read); the shell's half is the
    // caller's reloadExtensions(), which activates or retires the extension without a page reload.
    const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/enabled`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ enabled }),
        });
        await query.refetch();
    };
    // A cli provider's connector spec from the installed extensions' contributes.connectors — the data
    // capabilityEffects derives a cli card's secret/image effects from. Undefined until /extensions loads.
    const connectorOf = (provider: string): ConnectorContribution | undefined =>
        extensions.value
            .flatMap((extension) => extension.manifest.contributes?.connectors ?? [])
            .find((connector) => connector.provider === provider);
    return {
        extensions,
        setEnabled,
        connectorOf,
        // The list has actually arrived (or definitively failed) — gates decisions that must not fire against
        // the empty pre-fetch state, like bouncing an unknown /capabilities/<card> slug back to the grid.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
