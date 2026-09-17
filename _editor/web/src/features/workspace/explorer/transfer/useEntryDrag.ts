import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { movableInto } from "./explorerPaste";

// Pointer-driven moves of tree rows and desk tiles: Pointer Events, never the platform's own drag loop. A drag the page
// starts itself (a `draggable` row, a selected span, a picture) freezes the tab in Brave until the browser is restarted
// (brave/brave-browser#57753), so nothing in the app starts one; OS files still arrive by the platform's drag, which
// begins outside the page. Module-level singleton: one drag at a time, shared by every surface, so a row dragged from
// the tree can land on a desk tile. Surfaces offer targets with `data-drop-dir="<folder>"`, and read `over` to light
// the one the pointer is on.

// Far enough that a click with a shaky hand still selects rather than drags.
const DRAG_THRESHOLD_PX = 5;
const DROP_ATTR = `data-drop-dir`;

export interface EntryDragSpec {
    readonly paths: readonly string[];
    // Runs the move; the drag has already checked the target can take these paths.
    readonly onDrop: (dir: string) => void;
}

const dragging = ref(false);
const paths = ref<readonly string[]>([]);
const pointer = ref({ x: 0, y: 0 });
// The folder under the pointer, when it can take the paths; undefined over nothing, or over one that can't.
const over = ref<string | undefined>(undefined);
// What the ghost says: the one name, or a count.
const label = computed(() => {
    const [first] = paths.value;
    return paths.value.length === 1 && first !== undefined ? basename(first) : `${paths.value.length} items`;
});
let spec: EntryDragSpec | undefined;
let origin = { x: 0, y: 0 };
let listeners: AbortController | undefined;
let suppressClick = false;

// The folder the element at a point offers a drop into: its own, or the nearest ancestor's. "" is the root.
export const dropDirAt = (x: number, y: number): string | undefined => {
    const target = document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`);
    return target instanceof HTMLElement ? target.dataset[`dropDir`] : undefined;
};

const settle = (): void => {
    listeners?.abort();
    listeners = undefined;
    spec = undefined;
    dragging.value = false;
    paths.value = [];
    over.value = undefined;
    document.body.style.userSelect = ``;
};

const onMove = (event: PointerEvent): void => {
    pointer.value = { x: event.clientX, y: event.clientY };
    if (!dragging.value) {
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) {
            return;
        }
        dragging.value = true;
        suppressClick = true;
        // Or the press-and-drag paints a text selection across the tree.
        document.body.style.userSelect = `none`;
    }
    event.preventDefault();
    const dir = dropDirAt(event.clientX, event.clientY);
    over.value = dir !== undefined && movableInto(paths.value, dir).length > 0 ? dir : undefined;
};

const onUp = (): void => {
    const target = over.value;
    const current = spec;
    const moved = dragging.value;
    settle();
    if (moved && target !== undefined && current !== undefined) {
        current.onDrop(target);
    }
};

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        settle();
    }
};

// Arms a drag on the press; it becomes one only once the pointer travels far enough, so a plain click still selects.
// Mouse and pen only: a touch that lingers is a scroll or a long-press, not a drag.
export const beginEntryDrag = (event: PointerEvent, next: EntryDragSpec): void => {
    // Ahead of every guard: a press on any row ends the previous drag's claim, or the suppression could outlive its
    // drag and swallow the next row's first click.
    suppressClick = false;
    if (event.pointerType === `touch` || event.button !== 0 || next.paths.length === 0) {
        return;
    }
    settle();
    spec = next;
    paths.value = next.paths;
    origin = { x: event.clientX, y: event.clientY };
    pointer.value = origin;
    listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener(`pointermove`, onMove, { signal });
    window.addEventListener(`pointerup`, onUp, { signal });
    window.addEventListener(`pointercancel`, settle, { signal });
    window.addEventListener(`keydown`, onKey, { signal });
};

// A drag's pointerup also lands as a click on the row it started on; the row asks this before selecting or opening.
export const consumeSuppressedClick = (): boolean => {
    if (!suppressClick) {
        return false;
    }
    suppressClick = false;
    return true;
};

export function useEntryDrag() {
    return { dragging, paths, label, pointer, over, begin: beginEntryDrag, consumeSuppressedClick };
}
