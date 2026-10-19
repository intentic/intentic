import { loadChunk, Notice, SkeletonSnapshot, useLoadingReveal, vSkeletonSource } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { type Component, computed, defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, withDirectives } from "vue";
import { useRouter } from "vue-router";
import { whenIdle } from "../../lib/whenIdle";
import HubSectionOutline from "./HubSectionOutline.vue";

// A HUB SECTION'S CODE, FETCHED WHEN THE SECTION IS OPENED. A hub draws one section at a time, so bundling them all
// into the hub's chunk made a reload of any one page pay for every page. Each section is a chunk of its own instead,
// waited for the way a route's chunk is (components/asyncView.ts): nothing for a short wait; past the reveal delay
// data skeletons use, the section as it last looked (its imprint), or the body of the hub's route outline until it has
// been seen once; a dead chunk gets loadChunk's one reload, and any other failure a notice with a retry. Not Vue's
// defineAsyncComponent: it keeps a failed load's rejection for the life of the tab, so a section that failed once
// would stay blank until a reload, and its loading component has no imprint to draw.
// Once the hub has drawn the section it opened on, it warms the rest at idle (useSectionWarmup), so moving between
// sections draws at once, as it did when they were all in one chunk.

type Loader<T> = () => Promise<{ readonly default: T }>;

interface SectionChunk {
    /** Fetches the chunk once for every mount and the warm-up together; a failed fetch is fetched afresh next time. */
    readonly fetch: () => Promise<void>;
    /** Whether the section draws without a wait now. Reactive. */
    readonly landed: () => boolean;
}

// One entry per section component, made once as its hub's module is read
const chunks = new WeakMap<object, SectionChunk>();
// The waits a drawn section is in, which the warm-up lets finish before it starts its own
const arriving = new Set<Promise<string | undefined>>();

// What a wait ended in: nothing when it landed, the failure's words when it did not.
const failureOf = async (wait: Promise<void>): Promise<string | undefined> => {
    try {
        await wait;
        return undefined;
    } catch (error) {
        return String(error);
    }
};

/**
 * A section of a hub whose code is fetched the first time it is drawn: a stand-in for the component `load` resolves to,
 * taking the same props, attributes and slots.
 */
export const lazySection = <T extends Component>(load: Loader<T>): T => {
    // Survives unmounts, so a section drawn once (or warmed) draws synchronously from then on.
    const resolved = shallowRef<Component | undefined>(undefined);
    let inflight: Promise<void> | undefined;
    const fetch = (): Promise<void> => {
        if (inflight === undefined) {
            const fetching = load().then((module) => {
                resolved.value = module.default;
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

    const wrapper: Component = defineComponent({
        name: `LazySection`,
        // Everything handed to the stand-in is the section's: it declares no props of its own.
        inheritAttrs: false,
        setup(_props, { attrs, slots }) {
            const router = useRouter();
            // Per path, as a route's view is imprinted (asyncView.ts), under a name of the hub's own: the route's imprint
            // is the whole hub, rail and all. Read once, since a stand-in is only ever drawn for one section.
            const imprint = `hub:${router.currentRoute.value.path}`;
            const loading = ref(false);
            const failure = ref<string | undefined>(undefined);
            const attempt = (): void => {
                if (resolved.value !== undefined) {
                    return;
                }
                failure.value = undefined;
                loading.value = true;
                // A dead chunk's reload never settles, so the wait stays up while the page goes.
                const arrival = failureOf(loadChunk(fetch, router.resolve(router.currentRoute.value.fullPath).href));
                arriving.add(arrival);
                void arrival.then((failed) => {
                    failure.value = failed;
                    loading.value = false;
                    arriving.delete(arrival);
                });
            };
            attempt();
            const revealed = useLoadingReveal(
                loading,
                computed(() => imprint),
            );

            return () => {
                const section = resolved.value;
                if (section !== undefined) {
                    // `contents`, so the section lays out in the hub as if nothing wrapped it, while this element is one
                    // thing to imprint whatever root the section has.
                    return withDirectives(h(`div`, { class: `contents` }, [h(section, { ...attrs }, slots)]), [[vSkeletonSource, imprint]]);
                }
                if (failure.value !== undefined) {
                    return h(Notice, {
                        of: {
                            tone: `danger`,
                            title: t(`common.asyncView.viewCouldntLoad`),
                            detail: failure.value,
                            action: { label: t(`ui.action.tryAgain`), run: attempt },
                        },
                    });
                }
                return revealed.value ? h(SkeletonSnapshot, { of: imprint, label: t(`ui.status.loading`) }, { default: () => h(HubSectionOutline) }) : null;
            };
        },
    });
    chunks.set(wrapper, { fetch, landed: () => resolved.value !== undefined });
    // SAFETY: the stand-in hands every prop, attribute and slot it is given to the component `load` resolves to, so it
    // takes exactly what that component takes.
    return wrapper as T;
};

const chunkOf = (section: Component | undefined): SectionChunk | undefined => (section === undefined ? undefined : chunks.get(section));

/** Whether `section` would draw now, without a wait. Reactive; a component that is not a lazy section always has. */
export const sectionLanded = (section: Component | undefined): boolean => chunkOf(section)?.landed() ?? true;

/** Fetches every one of `sections` that has not landed, together, and settles when all have, however they settled. */
export const fetchSections = async (sections: readonly (Component | undefined)[]): Promise<void> => {
    await Promise.allSettled(sections.map((section) => chunkOf(section)?.fetch()));
};

/**
 * Warms the chunks of `sections` one at a time, each in an idle moment, once the section the hub opened on has drawn:
 * after the first paint, moving to another section draws at once. Read afresh at every step, so the walk follows an
 * index that fills in or changes with the reader; it ends when the hub unmounts.
 */
export const useSectionWarmup = (sections: () => readonly (Component | undefined)[]): void => {
    let live = true;
    // Each chunk once per walk: one that fails is the click path's to retry, which recovers its own failures.
    const tried = new Set<SectionChunk>();
    const warm = async (chunk: SectionChunk): Promise<void> => {
        try {
            await chunk.fetch();
        } catch {
            // allow(silent-catch): background work; the click path surfaces and recovers its own failures.
        }
    };
    const step = (): void => {
        whenIdle(() => {
            if (!live) {
                return;
            }
            const cold = sections()
                .map(chunkOf)
                .find((chunk) => chunk !== undefined && !chunk.landed() && !tried.has(chunk));
            if (cold === undefined) {
                return;
            }
            tried.add(cold);
            void warm(cold).then(step);
        });
    };
    // Mounted is after the open section's stand-in has asked for its chunk; that one goes first, alone.
    onMounted(() => {
        void Promise.allSettled(arriving).then(step);
    });
    onBeforeUnmount(() => {
        live = false;
    });
};
