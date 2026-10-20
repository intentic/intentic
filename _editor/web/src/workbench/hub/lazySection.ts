import { Await } from "@intentic/ui";
import { type Component, defineComponent, h, onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useChunkLoaded, type ViewChunk, viewChunk } from "../../components/viewChunk";
import { whenIdle } from "../../lib/whenIdle";
import HubSectionOutline from "./HubSectionOutline.vue";

// A HUB SECTION'S CODE, FETCHED WHEN THE SECTION IS OPENED. A hub draws one section at a time, so bundling them all
// into the hub's chunk made a reload of any one page pay for every page. Each section is a chunk of its own instead,
// waited for the way a route's chunk is (components/viewChunk.ts, drawn by <Await>): nothing for a short wait; past the
// reveal delay, the section as it last looked (its imprint), or the body of the hub's route outline until it has been
// seen once, standing until the section's own first reads have answered too; a dead chunk gets loadChunk's one reload,
// and any other failure a notice with a retry.
// Once the hub has drawn the section it opened on, it warms the rest at idle (useSectionWarmup), so moving between
// sections draws at once, as it did when they were all in one chunk.

type Loader<T> = () => Promise<{ readonly default: T }>;

// One chunk per section component, made once as its hub's module is read
const chunks = new WeakMap<object, ViewChunk<Component>>();
// The waits a drawn section is in, which the warm-up lets finish before it starts its own
const arriving = new Set<Promise<void>>();

/**
 * A section of a hub whose code is fetched the first time it is drawn: a stand-in for the component `load` resolves to,
 * taking the same props, attributes and slots. `name` tells it apart from the other sections a page can draw together
 * (a settings page and its parts), since what it last looked like is remembered per path and per section.
 */
export const lazySection = <T extends Component>(name: string, load: Loader<T>): T => {
    const chunk = viewChunk<Component>(async () => (await load()).default);

    const wrapper: Component = defineComponent({
        name: `LazySection`,
        // Everything handed to the stand-in is the section's: it declares no props of its own.
        inheritAttrs: false,
        setup(_props, { attrs, slots }) {
            const router = useRouter();
            // Per path, as a route's view is imprinted (asyncView.ts), under a name of the hub's own: the route's imprint
            // is the whole hub, rail and all. Read once, since a stand-in is only ever drawn for one section.
            const imprint = `hub:${router.currentRoute.value.path}#${name}`;
            const section = useChunkLoaded(() => chunk);
            if (chunk.landed() === undefined) {
                // The same fetch the wait above made; settled either way, the warm-up may go on.
                const arrival = chunk.fetch();
                arriving.add(arrival);
                void Promise.allSettled([arrival]).then(() => arriving.delete(arrival));
            }
            return () =>
                h(
                    Await,
                    { of: section.value, imprint },
                    {
                        default: ({ data }: { readonly data: Component }) => h(data, { ...attrs }, slots),
                        fallback: () => h(HubSectionOutline),
                    },
                );
        },
    });
    chunks.set(wrapper, chunk);
    // SAFETY: the stand-in hands every prop, attribute and slot it is given to the component `load` resolves to, so it
    // takes exactly what that component takes.
    return wrapper as T;
};

const chunkOf = (section: Component | undefined): ViewChunk<Component> | undefined => (section === undefined ? undefined : chunks.get(section));

/** Whether `section` would draw now, without a wait. Reactive; a component that is not a lazy section always has. */
export const sectionLanded = (section: Component | undefined): boolean => {
    const chunk = chunkOf(section);
    return chunk === undefined || chunk.landed() !== undefined;
};

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
    const tried = new Set<ViewChunk<Component>>();
    const warm = async (chunk: ViewChunk<Component>): Promise<void> => {
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
                .find((chunk) => chunk !== undefined && chunk.landed() === undefined && !tried.has(chunk));
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
