import type { CapabilityContribution } from "@intentic/extension-api";
import type { CapabilityKind } from "@intentic/sandbox-contract";
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
    // What actually contributes right now. A disabled extension stays LISTED (that is what keeps its switch
    // reachable) but the daemon wires none of its contributions up, so anything derived from a contribution —
    // the /capabilities cards above all — must read this list, not `extensions`. Reading the wrong one is how a
    // card for a switched-off extension stayed on the grid and failed at the daemon with an unknown provider.
    const enabledExtensions = computed<ExtensionSummary[]>(() => extensions.value.filter((extension) => extension.enabled));
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
    // One card's contribution from the enabled extensions' contributes.capabilities — the data capabilityEffects
    // derives a card's secret/image effects from. Keyed by kind + id because an id is only unique within a kind.
    // Undefined until /extensions loads.
    const contributionOf = (kind: CapabilityKind, id: string): CapabilityContribution | undefined =>
        enabledExtensions.value
            .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
            .find((contribution) => contribution.kind === kind && contribution.id === id);
    return {
        extensions,
        enabled: enabledExtensions,
        setEnabled,
        contributionOf,
        // The list has actually arrived (or definitively failed) — gates decisions that must not fire against
        // the empty pre-fetch state, like bouncing an unknown /capabilities/<card> slug back to the grid.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
