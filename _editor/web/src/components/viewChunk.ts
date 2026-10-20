import { type Loaded, useLoaded } from "@intentic/extension-api";
import { loadChunk } from "@intentic/ui";
import { type ComputedRef, inject, ref, shallowRef, watch } from "vue";
import { routerKey } from "vue-router";

// A VIEW'S CODE, AS A READ. A route's view (asyncView.ts), a hub's section (workbench/hub/lazySection.ts) and an
// extension's view (core-views/ExtensionView.vue) are each a chunk fetched the first time it is drawn, and each waits for
// it the same way: one fetch shared by every mount and the idle prefetcher, kept for the life of the tab once landed so a
// revisit draws at once, fetched afresh after a failure rather than replaying it, and a dead chunk answered by
// loadChunk's one reload onto the page just landed on. What a mount has of it is a `Loaded`, drawn by <Await>.

export interface ViewChunk<T> {
    /** Fetches the chunk once for every caller; a failed fetch is fetched afresh next time. */
    readonly fetch: () => Promise<void>;
    /** The landed code, or undefined until then. Reactive. */
    readonly landed: () => T | undefined;
}

// What a wait ended in: nothing when it landed, the failure's words when it did not.
const failureOf = async <T>(wait: Promise<T>): Promise<string | undefined> => {
    try {
        await wait;
        return undefined;
    } catch (error) {
        return String(error);
    }
};

export const viewChunk = <T>(load: () => Promise<T>): ViewChunk<T> => {
    // Survives unmounts, so a view drawn once (or warmed) draws synchronously from then on.
    const resolved = shallowRef<T | undefined>(undefined);
    let inflight: Promise<void> | undefined;
    const fetch = (): Promise<void> => {
        if (inflight === undefined) {
            const fetching = load().then((landed) => {
                resolved.value = landed;
            });
            inflight = fetching;
            // A later mount fetches again rather than replaying this rejection forever. Whoever asked still hears it.
            void failureOf(fetching).then((failed) => {
                if (failed !== undefined && inflight === fetching) {
                    inflight = undefined;
                }
            });
        }
        return inflight;
    };
    return { fetch, landed: () => resolved.value };
};

/**
 * A mount's wait for the chunk `chunk()` names now (it may change under a mounted host, as an extension's view does).
 * Only a mount answers a dead chunk with a reload, never the idle prefetcher; one in flight never settles, so the wait
 * stays up while the page goes. Nothing named yet is a wait while `pending()` (the host still finding the view out),
 * else nothing asked for.
 */
export const useChunkLoaded = <T>(chunk: () => ViewChunk<T> | undefined, pending: () => boolean = () => false): ComputedRef<Loaded<T>> => {
    // Outside a router (an extension's view in a side panel of a window without one) the reload lands where the reader is.
    const router = inject(routerKey, undefined);
    const failure = ref<string | undefined>(undefined);
    const trying = ref(false);
    const attempt = (): void => {
        const asked = chunk();
        if (asked === undefined || asked.landed() !== undefined) {
            return;
        }
        failure.value = undefined;
        trying.value = true;
        const target = router === undefined ? undefined : router.resolve(router.currentRoute.value.fullPath).href;
        void failureOf(loadChunk(asked.fetch, target)).then((failed) => {
            if (chunk() === asked) {
                failure.value = failed;
                trying.value = false;
            }
        });
    };
    watch(chunk, attempt, { immediate: true });
    // The chunk is what the host's <Await> waits on as its own answer, not a read joined to the region around it.
    return useLoaded<T>(
        () => {
            const asked = chunk();
            return {
                data: asked?.landed(),
                error: failure.value,
                fetching: trying.value,
                wanted: asked !== undefined || pending(),
                retry: attempt,
            };
        },
        { join: false },
    );
};
