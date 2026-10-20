import { Await, Notice } from "@intentic/ui";
import { type Component, computed, defineComponent, h, nextTick, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { t } from "@intentic/ui/i18n";
import { finishBoot } from "../app/perf/boot";
import { useChunkLoaded, viewChunk } from "./viewChunk";

// Wraps a route's `() => import(...)` so navigation completes immediately, and waits for the chunk as every view waits
// (<Await>, over viewChunk.ts): a dead chunk gets loadChunk's one reload onto the page just landed on, anything else a
// notice with retry. A view with an outline is remembered per path (`route:<path>`): the next wait for it draws the
// page as it last looked, the outline only until it has been seen once, and its first reads are waited for under that
// look too. A view without one draws nothing until its code is here, then waits for itself.

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
    const chunk = viewChunk(async () => (await load()).default);
    registered.push(options.mobile === undefined ? { load: chunk.fetch } : { load: chunk.fetch, mobile: options.mobile });

    const wrapper = defineComponent({
        name: `AsyncView`,
        setup() {
            const router = useRouter();
            const view = useChunkLoaded(() => chunk);
            // The page load ends where its first view has drawn (app/perf/boot.ts; a no-op after the first).
            const drawn = (): void => finishBoot(String(router.currentRoute.value.name ?? router.currentRoute.value.path));
            onMounted(() => {
                if (chunk.landed() !== undefined) {
                    drawn();
                }
            });
            watch(
                () => chunk.landed(),
                (shown) => {
                    if (shown !== undefined) {
                        void nextTick(drawn);
                    }
                },
            );
            // Per path, not per route: one hub's sections are different pages.
            const imprint = computed(() => (outline === undefined ? undefined : `route:${router.currentRoute.value.path}`));

            return () =>
                h(
                    Await,
                    { of: view.value, imprint: imprint.value },
                    {
                        default: ({ data }: { readonly data: Component }) => h(data),
                        // Without an outline the wait is only marked busy: a page drawn before its code would be a guess.
                        fallback: () => (outline === undefined ? h(`div`, { class: `contents`, "aria-busy": `true` }) : h(outline)),
                        failed: ({ error, retry }: { readonly error: string; readonly retry: (() => void) | undefined }) =>
                            h(`div`, { class: `ui-page` }, [
                                h(Notice, {
                                    of: {
                                        tone: `danger`,
                                        title: t(`common.asyncView.viewCouldntLoad`),
                                        detail: error,
                                        action: retry === undefined ? undefined : { label: t(`ui.action.tryAgain`), run: retry },
                                    },
                                }),
                            ]),
                    },
                );
        },
    });
    loaderOf.set(wrapper, chunk.fetch);
    return wrapper;
};
