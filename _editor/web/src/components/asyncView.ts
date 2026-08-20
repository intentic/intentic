import { Notice } from "@intentic/ui";
import { type Component, computed, defineComponent, h, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import { useLoadingReveal } from "@intentic/ui";
import { clearStaleChunkReload, isStaleChunkError, recoverStaleChunk } from "../router/staleChunk";

/* A VIEW WHOSE CODE ARRIVES BEHIND AN OUTLINE, the mechanism behind the app's routing rule that NAVIGATION
 * NEVER WAITS. A route record whose component is `() => import(…)` hands vue-router a promise, and the router
 * completes the navigation only once the chunk has arrived: the click does nothing visible for as long as the
 * download takes, which on a cold cache was a multi-second frozen click charged to whichever page happened to
 * be heaviest (the sandbox hub, at 212KB the largest route chunk in the build). The freeze is not a loading
 * STATE, it is the absence of one, and the app already has a doctrine for how waits are drawn (SkeletonRows,
 * useLoadingReveal). This applies that doctrine to code the way the views apply it to data.
 *
 * `asyncView(load, outline)` returns a SYNCHRONOUS component the route table registers directly, so the URL
 * and the view flip in the same tick as the click. Inside, the chunk loads exactly once (shared across every
 * mount and the idle prefetcher, see router/prefetch.ts) and until it lands the wrapper shows `outline`,
 * gated by the same reveal-delay/minimum-hold thresholds every data skeleton obeys: a warm revisit paints no
 * placeholder at all, and a cold one holds its outline long enough not to strobe. A view with no outline
 * (workspace editor, terminal, surfaces whose own inner skeletons are the honest shape) renders nothing over
 * the shell's background instead, which is the same neutral surface, undressed.
 *
 * THE FAILURE PATH IS PART OF THE CONTRACT, because moving the load out of the route record moves it out of
 * the router's sight: a rejected loader here happens inside an already-completed navigation, where the
 * router.onError stale-chunk handler (router/index.ts) can never see it. So the wrapper answers a dead chunk
 * itself, with the same shared recovery (staleChunk.ts), one reload per destination, landed on the route the
 * user asked for. Anything else, and a destination that already spent its one reload, gets a notice with the
 * retry, rather than the silent blank an unhandled rejection would leave. */

type Loader = () => Promise<{ readonly default: Component }>;

/* Every loader registered through asyncView, in registration order, the idle prefetcher walks this to pull
 * the chunks while nothing else wants the network. Shared state with the wrapper (not a second import()) so a
 * prefetched view mounts synchronously and a mounted view is never fetched twice. */
const registered: Array<() => Promise<unknown>> = [];
export const viewLoaders: readonly (() => Promise<unknown>)[] = registered;

export const asyncView = (load: Loader, outline?: Component): Component => {
    // One fetch for prefetcher and every mount alike; resolved survives unmounts, so a revisit is synchronous.
    const resolved = shallowRef<Component | undefined>(undefined);
    let inflight: Promise<unknown> | undefined;
    const start = (): Promise<unknown> => {
        inflight ??= load()
            .then((module) => {
                resolved.value = module.default;
                // A chunk resolving is the proof this window's chunks exist, the next redeploy earns its one
                // reload again. (The router's afterEach used to clear on "a navigation landed", but this
                // wrapper made landing unconditional, so that evidence went stale; this is where it lives now.)
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
                        // The reload is already in flight, keep the outline rather than flashing a notice at
                        // a page that is being replaced. Falls through to the notice when this destination has
                        // spent its one reload (the chunk is genuinely gone) or the failure isn't a dead chunk.
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
            // One loader per wrapper means one subject per wait, the constant is honest.
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
