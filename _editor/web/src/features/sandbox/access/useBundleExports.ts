import { BundleExportsSchema } from "@intentic/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { useEndpoint } from "../secrets/useEndpoint";
import { BUNDLE_EXPORTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The list of exports, read off the daemon's export directory rather than tracked in component state, so it
// stays correct across tabs and reloads. Polls only while something is packing.

const BUNDLE_EXPORTS_KEY = BUNDLE_EXPORTS.of();

// How often the list re-polls while a bundle is packing.
const PACKING_POLL_MS = 2_000;

export function useBundleExports() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: BUNDLE_EXPORTS_KEY,
        queryFn: async () => BundleExportsSchema.parse(await sandboxJson(`/bundles`)),
        refetchInterval: (state) => (state.state.data?.exports.some((entry) => entry.status === `packing`) ? PACKING_POLL_MS : false),
    });

    const exports = computed(() => query.data.value?.exports ?? []);
    // The in-flight export, if any; gates the start button so a mid-pack refresh doesn't look idle.
    const packing = computed(() => exports.value.find((entry) => entry.status === `packing`));
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: BUNDLE_EXPORTS_KEY });

    // Starts an export. Resolves once the daemon has named it, not once packing finishes, so the row appears
    // immediately and fills in as bytes land.
    const start = async (secrets: boolean): Promise<void> => {
        await sandboxJson(`/bundles${secrets ? `?secrets=1` : ``}`, { method: `POST` });
        await invalidate();
    };

    const remove = async (name: string): Promise<void> => {
        await sandboxJson(`/bundles?name=${encodeURIComponent(name)}`, { method: `DELETE` });
        await invalidate();
    };

    return { query, error, exports, packing, start, remove, invalidate };
}

// Download URL for a browser to navigate to directly, so bytes stream via its own download manager, not tab memory.
// The ticket is a short-lived credential scoped to this bundle, since a navigation can't carry a bearer header.
export const bundleDownloadUrl = async (name: string): Promise<string> => {
    const { ticket } = await sandboxJson<{ ticket: string }>(`/bundles/ticket?name=${encodeURIComponent(name)}`, { method: `POST` });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    return `${base}/bundles/download?${new URLSearchParams({ name, ticket }).toString()}`;
};
