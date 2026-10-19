import { loadChunk, Notice, SkeletonSnapshot, useLoadingReveal, vSkeletonSource } from "@intentic/ui";
import { type Component, computed, defineComponent, h, nextTick, onMounted, ref, shallowRef, watch, withDirectives } from "vue";
import { useRouter } from "vue-router";
import { t } from "@intentic/ui/i18n";
import { finishBoot } from "../app/perf/boot";

// Wraps a route's `() => import(...)` so navigation completes immediately; `outline` shows only past the same
// reveal-delay thresholds data skeletons use. Owns the failure path, invisible to router.onError once navigation lands:
// a dead chunk gets `loadChunk`'s one reload onto the page just landed on (the outline stays while it goes), anything
// else a notice with retry. A view with an outline is imprinted per path once it has drawn (`v-skeleton-source`), so the
// next wait for its chunk draws that page as it last looked, and `outline` only until it has been seen once.

type Loader = () => Promise<{ readonly default: Component }>;

// Where a view stands in the phone's idle prefetch (shell/prefetch/prefetch.ts): `first` for where a phone's next tap goes (an
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

// Each wrapper's own loader, by the component it returned, so a navigation can ask for the chunk of the view it is about
// to show while its guards still run (router/index.ts). The same shared fetch, so the mount that follows finds it done.
const loaderOf = new WeakMap<Component, () => Promise<void>>();

/** Starts fetching an asyncView's chunk ahead of its mount; anything else is ignored. A failure is left to the mount. */
export const warmView = (component: Component): void => {
    // allow(silent-catch): a warm that fails is retried by the mount, which owns the failure path (loadChunk, notice).
    loaderOf.get(component)?.().catch(() => undefined);
};

export const asyncView = (load: Loader, outline?: Component, options: { readonly mobile?: MobilePrefetch } = {}): Component => {
    // One fetch shared by the prefetcher and every mount; survives unmounts, so a revisit renders synchronously.
    const resolved = shallowRef<Component | undefined>(undefined);
    let inflight: Promise<void> | undefined;
    const start = (): Promise<void> => {
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
    const fetchChunk = (): Promise<void> => start();
    registered.push(options.mobile === undefined ? { load: fetchChunk } : { load: fetchChunk, mobile: options.mobile });

    const wrapper = defineComponent({
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
            // The page load ends where its first view has drawn (app/perf/boot.ts; a no-op after the first).
            const drawn = (): void => finishBoot(String(router.currentRoute.value.name ?? router.currentRoute.value.path));
            onMounted(() => {
                if (resolved.value !== undefined) {
                    drawn();
                }
            });
            watch(resolved, (shown) => {
                if (shown !== undefined) {
                    void nextTick(drawn);
                }
            });
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
    loaderOf.set(wrapper, fetchChunk);
    return wrapper;
};
