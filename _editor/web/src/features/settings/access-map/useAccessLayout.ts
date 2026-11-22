import { nextTick, onBeforeUnmount, onMounted, type Ref, shallowRef, watch } from "vue";
import { type Rect, within } from "../../../lib/geometry/mapGeometry";
import type { AccessLayout } from "./accessMapDrawing";

// WHERE THE ACCESS MAP'S CARDS LANDED. The stage lays them out with CSS; this reads every card marked `data-access-node`
// back so the lines can be drawn between them, again whenever the stage changes size or what it draws changes, once a
// frame at most. The sandbox's own map measures its stage the same way (sandbox/map/useMapLayout.ts).

const EMPTY: AccessLayout = { width: 0, height: 0, nodes: new Map() };

const read = (stage: HTMLElement): AccessLayout => {
    const frame = stage.getBoundingClientRect();
    const nodes = new Map<string, Rect>();
    for (const element of stage.querySelectorAll<HTMLElement>(`[data-access-node]`)) {
        nodes.set(element.dataset[`accessNode`] ?? ``, within(element.getBoundingClientRect(), frame));
    }
    return { width: frame.width, height: frame.height, nodes };
};

export function useAccessLayout<Watched>(stage: Ref<HTMLElement | undefined>, changes: () => Watched) {
    const width = shallowRef(0);
    const layout = shallowRef<AccessLayout>(EMPTY);
    let frame: number | undefined;
    const measure = (): void => {
        if (frame !== undefined) {
            return;
        }
        frame = requestAnimationFrame(() => {
            frame = undefined;
            if (stage.value === undefined) {
                return;
            }
            width.value = stage.value.getBoundingClientRect().width;
            // The width picks the columns; the cards are read once Vue has placed them in those columns.
            void nextTick(() => {
                if (stage.value !== undefined) {
                    layout.value = read(stage.value);
                }
            });
        });
    };
    const observer = new ResizeObserver(measure);
    onMounted(() => {
        if (stage.value !== undefined) {
            observer.observe(stage.value);
        }
        measure();
    });
    onBeforeUnmount(() => {
        observer.disconnect();
        if (frame !== undefined) {
            cancelAnimationFrame(frame);
        }
    });
    watch(changes, () => void nextTick(measure));
    return { width, layout };
}
