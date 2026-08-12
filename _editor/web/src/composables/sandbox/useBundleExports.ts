import { BundleExportsSchema } from "@intentic-app/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { useEndpoint } from "./useEndpoint";
import { BUNDLE_EXPORTS } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE EXPORTS THAT EXIST — read off the daemon's export directory, never remembered in a component.
 *
 * This is the whole fix for "I started an export, switched view, and the button forgot". Packing a real
 * workspace takes minutes; a `busy` ref inside a card cannot survive that, because the card does not. So the
 * daemon owns the work and this query owns nothing at all: it asks what is in the directory, and whatever the
 * answer is, that is the truth on every tab, after every refresh, tomorrow morning.
 *
 * The poll follows the work rather than the clock. While something is packing the list is the only channel
 * carrying its progress (a `.part` file's size, which no watcher reports — /history is deliberately outside the
 * one that pushes), so it ticks every couple of seconds. With nothing packing there is nothing to learn: a
 * finished bundle does not change, so the poll stops entirely and the card costs one request per open.
 */

export const BUNDLE_EXPORTS_KEY = BUNDLE_EXPORTS.of();

// Fast enough that a growing bundle looks alive, slow enough to be free next to the packing itself.
const PACKING_POLL_MS = 2_000;

export function useBundleExports() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: BUNDLE_EXPORTS_KEY,
        queryFn: async () => BundleExportsSchema.parse(await sandboxJson(`/bundles`)),
        refetchInterval: (state) => (state.state.data?.exports.some((entry) => entry.status === `packing`) ? PACKING_POLL_MS : false),
    });

    const exports = computed(() => query.data.value?.exports ?? []);
    // What the card gates its start button on — and what makes a refresh mid-pack land on "still packing"
    // rather than on a button that looks untouched.
    const packing = computed(() => exports.value.find((entry) => entry.status === `packing`));
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: BUNDLE_EXPORTS_KEY });

    // Kick one off. Answers as soon as the daemon has NAMED it, not when it finishes — the row appears
    // immediately and fills in as the bytes land.
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

/* The download URL a browser can NAVIGATE to, so the bytes stream to disk through its own download manager
 * instead of through the tab's memory. Same trick as mediaUrl and for the same reason: a navigation cannot
 * carry a bearer, so the credential becomes a short-lived ticket scoped to this one bundle.
 *
 * Outside the composable because it needs nothing from it — a bundle's name is all there is to know. */
export const bundleDownloadUrl = async (name: string): Promise<string> => {
    const { ticket } = await sandboxJson<{ ticket: string }>(`/bundles/ticket?name=${encodeURIComponent(name)}`, { method: `POST` });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet — finish setup so it registers its address.`);
    }
    return `${base}/bundles/download?${new URLSearchParams({ name, ticket }).toString()}`;
};
