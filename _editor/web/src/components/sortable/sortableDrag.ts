import { lessMotion } from "@intentic/ui/motion";
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from "vue";
import { swallowClick } from "../../lib/swallowClick";

// A LIST ARRANGED BY DRAGGING ONE OF ITS ITEMS ALONG IT, the way Discord's servers, a Trello list or a Linear sidebar is:
// the item lifts off the list and follows the pointer (SortableLift.vue draws it), the place it would land is an empty
// dashed slot in the list, the others slide aside to make that room, and on release the lifted item settles into the
// slot before the list takes it back. Escape flies it home. Used by Home's rail of sandboxes (features/home/
// HomeSandboxes.vue) and the switcher's rows (features/sandbox/gates/SandboxSwitcher.vue), which share one order.
// Pointer Events, as the chat tile's drag (shell/rail/chatTileDrag.ts): a press that never travels stays the item's
// click and double-click. Mouse and pen only; a touch on the list scrolls it.

// Far enough that a click with a shaky hand still selects, as every drag in the app (shell/rail/chatTileDrag.ts).
const DRAG_THRESHOLD_PX = 5;

// How near the list's top or bottom edge a carried item scrolls a list too long for its frame, and how fast at the very
// edge, per frame: faster the deeper in, as a browser's own drag scrolls, so a long trip is quick and a near one exact.
const EDGE_PX = 40;
const MAX_SCROLL_PX = 14;

// How long the lifted item takes to settle into its slot on release, or back into its own on Escape.
export const SETTLE_MS = 180;

// Every item of the list carries this attribute, in the order of `ids`.
const SORTABLE_ITEM = `data-sortable-item`;

/** `ids` with the one at `from` taken out and put back at `to`, both indexes into `ids`. */
export const movedOrder = (ids: readonly string[], from: number, to: number): string[] => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
        next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
    }
    return next;
};

/** Which slot a point at `y` is over: the one whose middle is nearest, so the gap between two items goes to neither early. */
export const slotAt = (y: number, middles: readonly number[]): number => {
    let best = 0;
    for (const [index, middle] of middles.entries()) {
        if (Math.abs(y - middle) < Math.abs(y - (middles[best] ?? Infinity))) {
            best = index;
        }
    }
    return best;
};

/** How far to scroll this frame for a pointer at `y` in a frame from `top` to `bottom`: negative up, 0 away from the edges. */
export const edgeScroll = (y: number, top: number, bottom: number): number => {
    const depth = (into: number): number => Math.min(1, Math.max(0, (EDGE_PX - into) / EDGE_PX));
    return Math.round((depth(bottom - y) - depth(y - top)) * MAX_SCROLL_PX);
};

// Each item's middle, from the top of the list's content rather than the window, so a scroll does not move it.
const slotMiddles = (list: HTMLElement): number[] => {
    const frame = list.getBoundingClientRect();
    return [...list.querySelectorAll<HTMLElement>(`[${SORTABLE_ITEM}]`)].map((item) => {
        const rect = item.getBoundingClientRect();
        return rect.top + rect.height / 2 - frame.top + list.scrollTop;
    });
};

/** Where the lifted item is drawn, in viewport pixels; `settling` while it glides into its slot on release. */
export interface SortableLiftBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly settling: boolean;
}

export interface SortableDragOptions {
    /** The scrolling list the items stand in. */
    readonly list: () => HTMLElement | null | undefined;
    /** The items' ids in the order drawn now. */
    readonly ids: () => readonly string[];
    /** Where a carried item was let go: the whole new order. */
    readonly commit: (ids: string[]) => void;
}

export interface SortableDrag {
    /** The item being carried, once the press has travelled, until it has settled. Its place in the list is the slot. */
    readonly carried: Ref<string | undefined>;
    /** The order to draw while one is carried; `undefined` otherwise. */
    readonly preview: ComputedRef<readonly string[] | undefined>;
    /** The lifted copy's box while one is carried. */
    readonly lift: Ref<SortableLiftBox | undefined>;
    readonly press: (event: PointerEvent, id: string) => void;
}

// One press on one item, from the press to the end of its settle.
class Gesture {
    readonly carried = ref<string | undefined>(undefined);
    readonly lift = ref<SortableLiftBox | undefined>(undefined);
    readonly target = ref(0);
    readonly preview = computed(() => (this.carried.value === undefined ? undefined : movedOrder(this.order, this.from, this.target.value)));
    private order: readonly string[] = [];
    private from = 0;
    private origin = { x: 0, y: 0 };
    private pointerY = 0;
    // Where the pointer holds the item, from its top, and the item's own box at the press.
    private grabY = 0;
    private picked = { left: 0, width: 0, height: 0 };
    // Each slot's middle, from the top of the list's content, measured at the press: the items are drawn in the same
    // slots whatever order they stand in, so the measure holds while they make way.
    private middles: number[] = [];
    private listening: AbortController | undefined;
    private frame = 0;
    private settle: ReturnType<typeof setTimeout> | undefined;
    private cancelled = false;

    constructor(private readonly options: SortableDragOptions) {}

    readonly press = (event: PointerEvent, id: string): void => {
        if (event.pointerType === `touch` || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        const box = this.options.list();
        const item = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
        // A new press while the last one still settles: that one lands now.
        this.end();
        this.order = this.options.ids();
        this.from = this.order.indexOf(id);
        if (box === null || box === undefined || item === null || this.from < 0) {
            return;
        }
        this.middles = slotMiddles(box);
        this.cancelled = false;
        if (this.middles.length !== this.order.length) {
            return;
        }
        const rect = item.getBoundingClientRect();
        this.picked = { left: rect.left, width: rect.width, height: rect.height };
        this.grabY = event.clientY - rect.top;
        this.origin = { x: event.clientX, y: event.clientY };
        this.pointerY = event.clientY;
        this.target.value = this.from;
        this.listen();
    };

    readonly end = (): void => {
        this.listening?.abort();
        this.listening = undefined;
        this.finish();
    };

    private listen(): void {
        this.listening = new AbortController();
        const { signal } = this.listening;
        window.addEventListener(`pointermove`, this.onMove, { signal });
        window.addEventListener(`pointerup`, this.onUp, { signal });
        window.addEventListener(`pointercancel`, this.end, { signal });
        // Away to another window mid-drag: the release may never be heard here, so the drag ends with the focus.
        window.addEventListener(`blur`, this.end, { signal });
        window.addEventListener(`keydown`, this.onKey, { signal, capture: true });
    }

    // Done with the lifted copy: the list draws its own order again.
    private finish(): void {
        clearTimeout(this.settle);
        this.settle = undefined;
        cancelAnimationFrame(this.frame);
        this.carried.value = undefined;
        this.lift.value = undefined;
        document.documentElement.style.removeProperty(`cursor`);
    }

    private readonly onMove = (event: PointerEvent): void => {
        const box = this.options.list();
        if (box === null || box === undefined || this.cancelled) {
            return;
        }
        this.pointerY = event.clientY;
        if (this.carried.value === undefined) {
            if (Math.hypot(event.clientX - this.origin.x, event.clientY - this.origin.y) < DRAG_THRESHOLD_PX) {
                return;
            }
            this.carried.value = this.order[this.from];
            // Held over whatever the pointer crosses, so the hand reads "carrying" off the list too.
            document.documentElement.style.setProperty(`cursor`, `grabbing`);
            this.frame = requestAnimationFrame(this.tick);
        }
        // Without this a press-and-drag paints a text selection across whatever it passes.
        event.preventDefault();
        this.follow(box);
    };

    // The lifted copy rides the pointer up and down the list, never off its side nor further than half past its ends.
    private follow(box: HTMLElement): void {
        const rect = box.getBoundingClientRect();
        const half = this.picked.height / 2;
        const top = Math.min(Math.max(this.pointerY - this.grabY, rect.top - half), rect.bottom - half);
        this.lift.value = { left: this.picked.left, top, width: this.picked.width, height: this.picked.height, settling: false };
        this.target.value = slotAt(this.pointerY - rect.top + box.scrollTop, this.middles);
    }

    // A list too long for its frame scrolls while the pointer rests by its edge, not only while it moves there.
    private readonly tick = (): void => {
        const box = this.options.list();
        if (box === null || box === undefined || this.carried.value === undefined || this.cancelled || this.settle !== undefined) {
            return;
        }
        const rect = box.getBoundingClientRect();
        const step = edgeScroll(this.pointerY, rect.top, rect.bottom);
        if (step !== 0) {
            box.scrollTop += step;
            this.follow(box);
        }
        this.frame = requestAnimationFrame(this.tick);
    };

    private readonly onUp = (): void => {
        const moved = this.carried.value !== undefined || this.cancelled;
        const next = this.preview.value;
        this.listening?.abort();
        this.listening = undefined;
        if (!moved) {
            this.finish();
            return;
        }
        // The release also lands as the item's click, which would select it: swallowed, as a drag is no press.
        swallowClick();
        if (this.cancelled) {
            return;
        }
        if (next !== undefined && this.target.value !== this.from) {
            this.options.commit([...next]);
        }
        this.settleInto(this.target.value);
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        if (event.key !== `Escape` || this.carried.value === undefined || this.cancelled) {
            return;
        }
        // Only the drag hears it: an Escape meant to put the item back must not also close whatever is open under it.
        event.preventDefault();
        event.stopPropagation();
        // Back to its place, still held: the release then lands as nothing, neither a move nor the item's click.
        this.cancelled = true;
        this.target.value = this.from;
        this.settleInto(this.from);
    };

    // The lifted copy glides into slot `index`, measured from the list as it stands now, and is gone.
    private settleInto(index: number): void {
        const box = this.options.list();
        const middle = this.middles[index];
        if (box === null || box === undefined || middle === undefined || this.lift.value === undefined || lessMotion()) {
            this.finish();
            return;
        }
        cancelAnimationFrame(this.frame);
        const top = box.getBoundingClientRect().top - box.scrollTop + middle - this.picked.height / 2;
        this.lift.value = { ...this.lift.value, top, settling: true };
        this.settle = setTimeout(() => this.finish(), SETTLE_MS);
    }
}

export function useSortableDrag(options: SortableDragOptions): SortableDrag {
    const gesture = new Gesture(options);
    onScopeDispose(gesture.end);
    return { carried: gesture.carried, preview: gesture.preview, lift: gesture.lift, press: gesture.press };
}
