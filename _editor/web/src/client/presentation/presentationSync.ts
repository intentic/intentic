import { errorMessage } from "@intentic/base/errors";
import type { SandboxSummary } from "@intentic/api-contract";
import type { QueryClient } from "@tanstack/vue-query";
import { type Ref, watch } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { directMode } from "../directory/directState";
import { type SandboxRpc, sandboxRpc } from "../sandbox/sandboxRpc";
import { supportsRoute } from "../sandbox/useDaemonRoutes";
import { SANDBOX_LIST_KEY, useSandbox } from "../sandbox/useSandbox";

// THE SANDBOX'S OWN COPY OF ITS NAME AND LOGO (2026-11-09). The platform holds the owner's name for a sandbox and its
// logo; the daemon now keeps a copy (`GET /system/presentation`, refreshed by its hourly announce), so a reader who
// reaches the sandbox directly can be shown them with the platform down. Two duties here, both for the open sandbox:
//
// - The platform took a new name or logo (a rename, a logo set or cleared, here or in another tab): the sandbox is asked
//   to fetch its copy at once (`POST /system/presentation/refresh`) rather than at its next announce, an hour away.
// - The window is open without the platform (features/sandbox/recovery/directMode.ts): the open sandbox's row takes the
//   name and logo the sandbox keeps, so one this device never remembered stops being named after its host.
//
// Each only where the daemon has the route; an older one is left as it was.

/** What the sync talks to: the open sandbox and whether it answers, the daemon, and the list's cache entry. */
export interface PresentationSyncSeams {
    readonly active: Readonly<Ref<SandboxSummary | undefined>>;
    readonly reachable: Readonly<Ref<boolean>>;
    readonly rpc: Pick<SandboxRpc, `system`>;
    readonly supports: (route: string) => boolean;
    readonly cache: Pick<QueryClient, `setQueryData`>;
}

const liveSeams = (): PresentationSyncSeams => {
    const { active, reachable } = useSandbox();
    return { active, reachable, rpc: sandboxRpc, supports: supportsRoute, cache: queryClient };
};


export const startPresentationSync = (seams: PresentationSyncSeams = liveSeams()): void => {
    const { active, reachable, rpc, supports, cache } = seams;

    watch(
        () => (active.value === undefined ? undefined : { id: active.value.id, name: active.value.name, image: active.value.image }),
        (now, before) => {
            if (now === undefined || before === undefined || now.id !== before.id || directMode.value) {
                return;
            }
            if (now.name === before.name && now.image === before.image) {
                return;
            }
            if (!reachable.value || !supports(`system.presentationRefresh`)) {
                return;
            }
            void rpc.system.presentationRefresh().catch((error: Error) => {
                console.warn(`[presentation] the sandbox did not take its new name and logo: ${errorMessage(error)}`);
            });
        },
    );

    // Direct mode is a source too: a window can turn direct while its sandbox already answers.
    watch(
        [reachable, () => active.value?.id, directMode] as const,
        async ([up, id, direct]) => {
            if (!up || id === undefined || !direct || !supports(`system.presentation`)) {
                return;
            }
            let held: Awaited<ReturnType<SandboxRpc[`system`][`presentation`]>>;
            try {
                held = await rpc.system.presentation();
            } catch (error) {
                console.warn(`[presentation] the sandbox's own name and logo could not be read: ${errorMessage(error)}`);
                return;
            }
            const kept = held.presentation;
            // The platform may have taken the window back meanwhile: then its list is the word, not the sandbox's copy.
            if (kept === null || !directMode.value) {
                return;
            }
            cache.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (rows) =>
                rows?.map((row) => (row.id === id ? { ...row, name: kept.name === `` ? row.name : kept.name, image: kept.image } : row)),
            );
        },
        { immediate: true },
    );
};
