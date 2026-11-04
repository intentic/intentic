import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from "vue";
import { swallowClick } from "../../lib/swallowClick";
import { movedOrder } from "../../models/home/sandboxOrder";

// A SANDBOX TILE, DRAGGED ALONG HOME'S RAIL to where the reader wants it, the way a chat app's servers are arranged
// (models/home/sandboxOrder.ts keeps where it was let go). The tiles make way while it is carried: the rail draws
// `preview` in place of its own order, so no ghost is needed. Pointer Events, as the chat tile's drag (shell/rail/
// chatTileDrag.ts): a press that never travels stays the tile's click and double-click, and Escape puts it back.
// Mouse and pen only; a touch on the rail scrolls it.

// Far enough that a click with a shaky hand still selects, as every drag in the app (shell/rail/chatTileDrag.ts).
const DRAG_THRESHOLD_PX = 5;

// How near the rail's top or bottom edge a carried tile scrolls a rail too long for the window, and by how much a move.
const EDGE_PX = 24;
const SCROLL_STEP_PX = 8;

/** Which slot a point at `y` is over: the one whose middle is nearest, so the gap between two tiles goes to neither early. */
export const slotAt = (y: number, middles: readonly number[]): number => {
    let best = 0;
    for (const [index, middle] of middles.entries()) {
        if (Math.abs(y - middle) < Math.abs(y - (middles[best] ?? Infinity))) {
            best = index;
        }
    }
    return best;
};

// Each tile's middle, from the top of the list's content rather than the window, so a scroll does not move it.
const slotMiddles = (list: HTMLElement): number[] => {
    const frame = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>(`[data-sandbox-tile]`)].map((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.top + rect.height / 2 - frame.top + list.scrollTop;
    });
};

export interface SandboxTileDragOptions {
    /** The scrolling list the tiles stand in; each tile is marked `data-sandbox-tile`, in the order of `ids`. */
    readonly list: () => HTMLElement | null | undefined;
    /** The tiles' ids in the order drawn now. */
    readonly ids: () => readonly string[];
    /** Where a carried tile was let go: the whole new order. */
    readonly commit: (ids: string[]) => void;
}

export interface SandboxTileDrag {
    /** The tile being carried, once the press has travelled. */
    readonly carried: Ref<string | undefined>;
    /** The order to draw while one is carried; `undefined` otherwise. */
    readonly preview: ComputedRef<readonly string[] | undefined>;
    readonly press: (event: PointerEvent, id: string) => void;
}

export function useSandboxTileDrag({ list, ids, commit }: SandboxTileDragOptions): SandboxTileDrag {
    const carried = ref<string | undefined>(undefined);
    const target = ref(0);
    let order: readonly string[] = [];
    let from = 0;
    let origin = { x: 0, y: 0 };
    // Each slot's middle, from the top of the list's content, measured at the press: the tiles are drawn in the same
    // slots whatever order they stand in, so the measure holds while they make way.
    let middles: number[] = [];
    let gesture: AbortController | undefined;
    let cancelled = false;

    const preview = computed(() => (carried.value === undefined ? undefined : movedOrder(order, from, target.value)));

    const end = (): void => {
        gesture?.abort();
        gesture = undefined;
        carried.value = undefined;
    };

    const onMove = (event: PointerEvent): void => {
        const box = list();
        if (box === null || box === undefined || cancelled) {
            return;
        }
        if (carried.value === undefined) {
            if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) {
                return;
            }
            carried.value = order[from];
        }
        // Without this a press-and-drag paints a text selection across whatever it passes.
        event.preventDefault();
        const frame = box.getBoundingClientRect();
        if (event.clientY < frame.top + EDGE_PX) {
            box.scrollTop -= SCROLL_STEP_PX;
        } else if (event.clientY > frame.bottom - EDGE_PX) {
            box.scrollTop += SCROLL_STEP_PX;
        }
        target.value = slotAt(event.clientY - frame.top + box.scrollTop, middles);
    };

    const onUp = (): void => {
        const moved = carried.value !== undefined || cancelled;
        const next = preview.value;
        end();
        if (!moved) {
            return;
        }
        // The release also lands as the tile's click, which would select it: swallowed, as a drag is no press.
        swallowClick();
        if (!cancelled && next !== undefined && target.value !== from) {
            commit([...next]);
        }
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key !== `Escape` || carried.value === undefined) {
            return;
        }
        // Only the drag hears it: an Escape meant to put the tile back must not also close whatever is open under it.
        event.preventDefault();
        event.stopPropagation();
        // Back in its place, still held: the release then lands as nothing, neither a move nor the tile's click.
        cancelled = true;
        carried.value = undefined;
    };

    const press = (event: PointerEvent, id: string): void => {
        if (event.pointerType === `touch` || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        const box = list();
        order = ids();
        from = order.indexOf(id);
        if (box === null || box === undefined || from < 0) {
            return;
        }
        end();
        middles = slotMiddles(box);
        cancelled = false;
        if (middles.length !== order.length) {
            return;
        }
        origin = { x: event.clientX, y: event.clientY };
        target.value = from;
        gesture = new AbortController();
        const { signal } = gesture;
        window.addEventListener(`pointermove`, onMove, { signal });
        window.addEventListener(`pointerup`, onUp, { signal });
        window.addEventListener(`pointercancel`, end, { signal });
        // Away to another window mid-drag: the release may never be heard here, so the drag ends with the focus.
        window.addEventListener(`blur`, end, { signal });
        window.addEventListener(`keydown`, onKey, { signal, capture: true });
    };

    onScopeDispose(end);

    return { carried, preview, press };
}
