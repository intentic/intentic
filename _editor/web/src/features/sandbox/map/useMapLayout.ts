import { nextTick, onBeforeUnmount, onMounted, type Ref, shallowRef, watch } from "vue";
import { type Rect, within } from "./mapGeometry";
import type { GroupKey, PrincipalKind } from "./reachModel";

// WHERE THE STAGE'S CARDS LANDED. The stage lays them out with CSS, which is what keeps the map readable at any width;
// this reads the result back so the lines can be drawn between them. Read again whenever the stage changes size (a
// group unfolding, the pane narrowing, a font arriving) and after the data it draws changes, one frame at a time.

export interface MapLayout {
    readonly width: number;
    readonly height: number;
    readonly box: Rect | undefined;
    readonly principals: ReadonlyMap<string, { readonly rect: Rect; readonly kind: PrincipalKind }>;
    /** Every node's card, inside the box and out; an outward one carries its group. */
    readonly nodes: ReadonlyMap<string, { readonly rect: Rect; readonly group: GroupKey | undefined }>;
    readonly groups: ReadonlyMap<GroupKey, Rect>;
}

const EMPTY: MapLayout = { width: 0, height: 0, box: undefined, principals: new Map(), nodes: new Map(), groups: new Map() };

const read = (stage: HTMLElement): MapLayout => {
    const frame = stage.getBoundingClientRect();
    const rectOf = (element: Element): Rect => within(element.getBoundingClientRect(), frame);
    const box = stage.querySelector(`[data-map-box]`);
    const principals = new Map<string, { rect: Rect; kind: PrincipalKind }>();
    for (const element of stage.querySelectorAll<HTMLElement>(`[data-principal]`)) {
        const kind = element.dataset[`kind`];
        if (kind === `person` || kind === `token` || kind === `link`) {
            principals.set(element.dataset[`principal`] ?? ``, { rect: rectOf(element), kind });
        }
    }
    const groups = new Map<GroupKey, Rect>();
    const nodes = new Map<string, { rect: Rect; group: GroupKey | undefined }>();
    for (const element of stage.querySelectorAll<HTMLElement>(`[data-node]`)) {
        // SAFETY: the group cards write `data-group` from a GroupKey, and nothing else on the stage writes the attribute.
        const group = element.closest<HTMLElement>(`[data-group]`)?.dataset[`group`] as GroupKey | undefined;
        nodes.set(element.dataset[`node`] ?? ``, { rect: rectOf(element), group });
    }
    for (const element of stage.querySelectorAll<HTMLElement>(`[data-group]`)) {
        // SAFETY: as above, the attribute is only ever a GroupKey.
        groups.set(element.dataset[`group`] as GroupKey, rectOf(element));
    }
    return { width: frame.width, height: frame.height, box: box === null ? undefined : rectOf(box), principals, nodes, groups };
};

export function useMapLayout<Watched>(stage: Ref<HTMLElement | undefined>, changes: () => Watched) {
    const layout = shallowRef<MapLayout>(EMPTY);
    let frame: number | undefined;
    const measure = (): void => {
        if (frame !== undefined) {
            return;
        }
        frame = requestAnimationFrame(() => {
            frame = undefined;
            if (stage.value !== undefined) {
                layout.value = read(stage.value);
            }
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
    return { layout, measure };
}
