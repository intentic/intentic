import { loadChunk, Notice, SkeletonSnapshot, useLoadingReveal, vSkeletonSource } from "@intentic/ui";
import { type Component, computed, defineComponent, h, ref, shallowRef, withDirectives } from "vue";
import { useRouter } from "vue-router";
import { t } from "@intentic/ui/i18n";

// Wraps a route's `() => import(...)` so navigation completes immediately; `outline` shows only past the same
// reveal-delay thresholds data skeletons use. Owns the failure path, invisible to router.onError once navigation lands:
// a dead chunk gets `loadChunk`'s one reload onto the page just landed on (the outline stays while it goes), anything
// else a notice with retry. A view with an outline is imprinted per path once it has drawn (`v-skeleton-source`), so the
// next wait for its chunk draws that page as it last looked, and `outline` only until it has been seen once.

type Loader = () => Promise<{ readonly default: Component }>;

// Where a view stands in the phone's idle prefetch (router/prefetch.ts): `first` for where a phone's next tap goes (an
// agent's page from the board, the menu), `skip` for a view a phone never draws, whose chunk would be downloaded and
// evaluated for nothing. Absent is route order, which is all a desktop ever uses.
export type MobilePrefetch = `first` | `skip`;

export interface ViewLoader {
    readonly load: () => Promise<unknown>;
    readonly mobile?: MobilePrefetch;
}

// Every registered loader, walked by the idle prefetcher; shared, so a prefetched view mounts synchronously.
const registered: ViewLoader[] = [];
export const viewLoaders: readonly ViewLoader[] = registered;

export const asyncView = (load: Loader, outline?: Component, options: { readonly mobile?: MobilePrefetch } = {}): Component => {
    // One fetch shared by the prefetcher and every mount; survives unmounts, so a revisit renders synchronously.
    const resolved = shallowRef<Component | undefined>(undefined);
    let inflight: Promise<unknown> | undefined;
    const start = (): Promise<unknown> => {
        inflight ??= load()
            .then((module) => {
                resolved.value = module.default;
            })
            .catch((error: unknown) => {
                // A later retry re-fetches rather than replaying this rejection forever.
                inflight = undefined;
                throw error;
            });
        return inflight;
    };
    const fetchChunk = (): Promise<unknown> => start();
    registered.push(options.mobile === undefined ? { load: fetchChunk } : { load: fetchChunk, mobile: options.mobile });

    return defineComponent({
        name: `AsyncView`,
        setup() {
            const router = useRouter();
            const loading = ref(false);
            const failure = ref<string | undefined>(undefined);
            const attempt = (): void => {
                if (resolved.value !== undefined) {
                    return;
                }
                failure.value = undefined;
                loading.value = true;
                // Only a mount answers a dead chunk with a reload, never the idle prefetcher; one in flight never
                // settles, so the outline stays until the page is replaced.
                loadChunk(start, router.resolve(router.currentRoute.value.fullPath).href)
                    .catch((error: unknown) => {
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
            // Per path, not per route: one hub's sections are different pages.
            const imprint = computed(() => `route:${router.currentRoute.value.path}`);

            return () => {
                if (resolved.value !== undefined) {
                    const view = h(resolved.value);
                    return outline === undefined ? view : withDirectives(view, [[vSkeletonSource, imprint.value]]);
                }
                if (failure.value !== undefined) {
                    return h(`div`, { class: `ui-page` }, [
                        h(Notice, {
                            of: {
                                tone: `danger`,
                                title: t(`common.asyncView.viewCouldntLoad`),
                                detail: failure.value,
                                action: { label: t(`ui.action.tryAgain`), run: attempt },
                            },
                        }),
                    ]);
                }
                return revealed.value && outline !== undefined ? h(SkeletonSnapshot, { of: imprint.value }, { default: () => h(outline) }) : null;
            };
        },
    });
};
