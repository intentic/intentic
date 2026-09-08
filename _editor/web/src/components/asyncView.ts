import { Notice, useLoadingReveal } from "@intentic/ui";
import { type Component, computed, defineComponent, h, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import { clearStaleChunkReload, isStaleChunkError, recoverStaleChunk } from "../router/staleChunk";

// Wraps a route's `() => import(...)` so navigation completes immediately; `outline` shows only past the same
// reveal-delay thresholds data skeletons use. Owns the failure path, invisible to router.onError once navigation lands:
// a dead chunk gets the shared stale-chunk reload (one per destination), anything else a notice with retry.

type Loader = () => Promise<{ readonly default: Component }>;

// Every registered loader, walked by the idle prefetcher; shared, so a prefetched view mounts synchronously.
const registered: Array<() => Promise<unknown>> = [];
export const viewLoaders: readonly (() => Promise<unknown>)[] = registered;

export const asyncView = (load: Loader, outline?: Component): Component => {
    // One fetch shared by the prefetcher and every mount; survives unmounts, so a revisit renders synchronously.
    const resolved = shallowRef<Component | undefined>(undefined);
    let inflight: Promise<unknown> | undefined;
    const start = (): Promise<unknown> => {
        inflight ??= load()
            .then((module) => {
                resolved.value = module.default;
                // A chunk resolving proves this window's assets are current; the next redeploy earns its own reload
                // again.
                clearStaleChunkReload();
            })
            .catch((error: unknown) => {
                // A later retry re-fetches rather than replaying this rejection forever.
                inflight = undefined;
                throw error;
            });
        return inflight;
    };
    registered.push(() => start());

    return defineComponent({
        name: `AsyncView`,
        setup() {
            const route = useRoute();
            const loading = ref(false);
            const failure = ref<string | undefined>(undefined);
            const attempt = (): void => {
                if (resolved.value !== undefined) {
                    return;
                }
                failure.value = undefined;
                loading.value = true;
                start()
                    .catch((error: unknown) => {
                        // Keeps the outline while a reload is in flight; falls through once this destination's one
                        // reload is spent.
                        if (isStaleChunkError(error) && recoverStaleChunk(route.fullPath)) {
                            return;
                        }
                        failure.value = String(error);
                    })
                    .finally(() => {
                        loading.value = false;
                    });
            };
            attempt();
            // One loader per wrapper: one subject per wait, so the label can stay empty.
            const revealed = useLoadingReveal(
                loading,
                computed(() => ``),
            );

            return () => {
                if (resolved.value !== undefined) {
                    return h(resolved.value);
                }
                if (failure.value !== undefined) {
                    return h(`div`, { class: `ui-page` }, [
                        h(Notice, {
                            of: {
                                tone: `danger`,
                                title: `This view couldn't load.`,
                                detail: failure.value,
                                action: { label: `Try again`, run: attempt },
                            },
                        }),
                    ]);
                }
                return revealed.value && outline !== undefined ? h(outline) : null;
            };
        },
    });
};
