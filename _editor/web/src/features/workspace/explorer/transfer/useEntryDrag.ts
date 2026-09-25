import { sandboxRef } from "@intentic/extension-api";
import { basename } from "@intentic/ui/path";
import { computed, ref } from "vue";
import { movableInto } from "./explorerPaste";

// Pointer-driven moves of tree rows and home tiles: Pointer Events, never the platform's own drag loop. A drag the page
// starts itself (a `draggable` row, a selected span, a picture) freezes the tab in Brave until the browser is restarted
// (brave/brave-browser#57753), so nothing in the app starts one; OS files still arrive by the platform's drag, which
// begins outside the page. Module-level singleton: one drag at a time, shared by every surface, so a row dragged from
// the tree can land on a home tile. Surfaces offer targets with `data-drop-dir="<folder>"`, and read `over` to light
// the one the pointer is on.

// Far enough that a click with a shaky hand still selects rather than drags.
const DRAG_THRESHOLD_PX = 5;
const DROP_ATTR = `data-drop-dir`;

export interface EntryDragSpec {
    readonly paths: readonly string[];
    // Runs the move; the drag has already checked the target can take these paths.
    readonly onDrop: (dir: string) => void;
}

// allow(module-state): one pointer gesture, ended by its release, its Escape, or a switch (its paths are the sandbox's, and scoped)
const dragging = ref(false);
// One sandbox's paths: a switch mid-drag (the keyboard's, the pointer still down) ends it, or the release would move
// the same paths in the sandbox switched to.
const paths = sandboxRef<readonly string[]>(
    () => [],
    () => endDrag(),
);
// allow(module-state): one pointer gesture, ended by its release, its Escape, or a switch (its paths are the sandbox's, and scoped)
const pointer = ref({ x: 0, y: 0 });
// The folder under the pointer, when it can take the paths; undefined over nothing, or over one that can't.
// allow(module-state): one pointer gesture, ended by its release, its Escape, or a switch (its paths are the sandbox's, and scoped)
const over = ref<string | undefined>(undefined);
// What the ghost says: the one name, or a count.
const label = computed(() => {
    const [first] = paths.value;
    return paths.value.length === 1 && first !== undefined ? basename(first) : `${paths.value.length} items`;
});
let spec: EntryDragSpec | undefined;
let origin = { x: 0, y: 0 };
let listeners: AbortController | undefined;
// When the drag that owns the pending click ended; `undefined` once no click is owed.
let suppressedAt: number | undefined;
// A click belongs to the pointerup before it, which the browser dispatches immediately after. Past this the claim is
// stale — a drag released over nothing (or cancelled by the OS) leaves a click nobody ever fires, and without a
// deadline that claim would swallow an unrelated row's click seconds later.
const CLICK_CLAIM_MS = 250;

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
        // Or the press-and-drag paints a text selection across the tree.
        document.body.style.userSelect = `none`;
    }
    event.preventDefault();
    const dir = dropDirAt(event.clientX, event.clientY);
    over.value = dir !== undefined && movableInto(paths.value, dir).length > 0 ? dir : undefined;
};

// Ends a drag by whatever finished it — release, Escape, the OS taking the gesture — and claims the click the browser
// still owes for it. Dated from the end, so a drag held for seconds still owns its own release.
const endDrag = (): void => {
    if (dragging.value) {
        suppressedAt = Date.now();
    }
    settle();
};

const onUp = (): void => {
    const target = over.value;
    const current = spec;
    const moved = dragging.value;
    endDrag();
    if (moved && target !== undefined && current !== undefined) {
        current.onDrop(target);
    }
};

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        endDrag();
    }
};

// Arms a drag on the press; it becomes one only once the pointer travels far enough, so a plain click still selects.
// Mouse and pen only: a touch that lingers is a scroll or a long-press, not a drag.
export const beginEntryDrag = (event: PointerEvent, next: EntryDragSpec): void => {
    // Ahead of every guard: a press on any row ends the previous drag's claim, or the suppression could outlive its
    // drag and swallow the next row's first click. Callers reach this on every press, carrying no paths when the row
    // cannot travel, so a locked or modified press ends the claim like any other.
    suppressedAt = undefined;
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
    window.addEventListener(`pointercancel`, endDrag, { signal });
    window.addEventListener(`keydown`, onKey, { signal });
};

// A drag's pointerup also lands as a click on the row it started on; the row asks this before selecting or opening.
export const consumeSuppressedClick = (): boolean => {
    if (suppressedAt === undefined) {
        return false;
    }
    const owed = Date.now() - suppressedAt < CLICK_CLAIM_MS;
    suppressedAt = undefined;
    return owed;
};

export function useEntryDrag() {
    return { dragging, paths, label, pointer, over, begin: beginEntryDrag, consumeSuppressedClick };
}
