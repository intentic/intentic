import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { t } from "@intentic/ui/i18n";
import { BUNDLE_EXPORTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The list of exports, read off the daemon's export directory rather than tracked in component state, so it
// stays correct across tabs and reloads. Polls only while something is packing.

const BUNDLE_EXPORTS_KEY = BUNDLE_EXPORTS.of();

// How often the list re-polls while a bundle is packing.
const PACKING_POLL_MS = 2_000;

export function useBundleExports() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: BUNDLE_EXPORTS_KEY,
        queryFn: () => sandboxRaw(`GET /bundles`),
        refetchInterval: (state) => (state.state.data?.exports.some((entry) => entry.status === `packing`) ? PACKING_POLL_MS : false),
    });

    const exports = computed(() => query.data.value?.exports ?? []);
    // The in-flight export, if any; gates the start button so a mid-pack refresh doesn't look idle.
    const packing = computed(() => exports.value.find((entry) => entry.status === `packing`));
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: BUNDLE_EXPORTS_KEY });

    // Starts an export. Resolves once the daemon has named it, not once packing finishes, so the row appears
    // immediately and fills in as bytes land.
    const start = async (secrets: boolean): Promise<void> => {
        await sandboxRaw(`POST /bundles`, { query: secrets ? { secrets: `1` } : undefined });
        await invalidate();
    };

    const remove = async (name: string): Promise<void> => {
        await sandboxRaw(`DELETE /bundles`, { query: { name } });
        await invalidate();
    };

    return { query, error, exports, packing, start, remove, invalidate };
}

// Download URL for a browser to navigate to directly, so bytes stream via its own download manager, not tab memory.
// The ticket is a short-lived credential scoped to this bundle, since a navigation can't carry a bearer header.
export const bundleDownloadUrl = async (name: string): Promise<string> => {
    const { ticket } = await sandboxRaw(`POST /bundles/ticket`, { query: { name } });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(t(`sandbox.useBundleExports.notReachableYet`));
    }
    return `${base}${rawRouteUrl(`GET /bundles/download`)}?${new URLSearchParams({ name, ticket }).toString()}`;
};
