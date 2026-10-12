import type { ModelRole } from "@intentic/sandbox-contract";
import { computed, onBeforeUnmount, ref } from "vue";

// A job chip dragged onto a setup: Pointer Events rather than HTML5 drag-and-drop, as the agent board does
// (agents/board/useAgentDrag.ts), for a real ghost, Escape to cancel and DOM hit-testing for the target. Mouse and pen
// only: on touch a drag would fight the scroll, and a tap opens the job's panel, which holds the same move as a list
// of setups (and is the keyboard's way too). A drop target is any element carrying `data-setup-drop`: a setup's id,
// `unassigned` for the list of jobs on none, or `new` for a setup made on the spot.

// Far enough that a click with a shaky hand still opens the job's panel.
const DRAG_THRESHOLD_PX = 5;

export type DropTarget = { readonly kind: `setup`; readonly id: string } | { readonly kind: `unassigned` } | { readonly kind: `new` };

const targetKey = (target: DropTarget): string => (target.kind === `setup` ? target.id : target.kind);

const targetAt = (x: number, y: number): DropTarget | undefined => {
    const zone = document.elementFromPoint(x, y)?.closest(`[data-setup-drop]`);
    const value = zone instanceof HTMLElement ? zone.dataset[`setupDrop`] : undefined;
    if (value === undefined || value === ``) {
        return undefined;
    }
    return value === `unassigned` || value === `new` ? { kind: value } : { kind: `setup`, id: value };
};

export function useJobDrag(drop: (role: ModelRole, target: DropTarget) => void) {
    const dragged = ref<ModelRole | undefined>(undefined);
    const dragging = ref(false);
    const over = ref<DropTarget | undefined>(undefined);
    const pointer = ref({ x: 0, y: 0 });
    let grabOffset = { x: 0, y: 0 };
    let origin = { x: 0, y: 0 };
    let listeners: AbortController | undefined;
    let suppressClick = false;

    const ghostStyle = computed(() => ({ transform: `translate3d(${pointer.value.x - grabOffset.x}px, ${pointer.value.y - grabOffset.y}px, 0)` }));

    const end = (): void => {
        listeners?.abort();
        listeners = undefined;
        dragged.value = undefined;
        dragging.value = false;
        over.value = undefined;
    };

    const onMove = (event: PointerEvent): void => {
        pointer.value = { x: event.clientX, y: event.clientY };
        if (!dragging.value) {
            if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) {
                return;
            }
            dragging.value = true;
            // A text selection started by the press would follow the pointer across the page.
            window.getSelection()?.removeAllRanges();
        }
        over.value = targetAt(event.clientX, event.clientY);
    };

    const onUp = (event: PointerEvent): void => {
        const role = dragged.value;
        const target = dragging.value ? targetAt(event.clientX, event.clientY) : undefined;
        // A drag's pointerup also lands as a click on the chip it started from; that click must not open the panel.
        suppressClick = dragging.value;
        end();
        if (role !== undefined && target !== undefined) {
            drop(role, target);
        }
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key === `Escape`) {
            suppressClick = dragging.value;
            end();
        }
    };

    /** Arms a drag on pointerdown; it becomes one only once the pointer travels far enough. */
    const begin = (event: PointerEvent, role: ModelRole, chip: HTMLElement): void => {
        suppressClick = false;
        if (event.pointerType === `touch` || event.button !== 0) {
            return;
        }
        const rect = chip.getBoundingClientRect();
        grabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        origin = { x: event.clientX, y: event.clientY };
        pointer.value = origin;
        dragged.value = role;
        dragging.value = false;
        listeners = new AbortController();
        const { signal } = listeners;
        window.addEventListener(`pointermove`, onMove, { signal });
        window.addEventListener(`pointerup`, onUp, { signal });
        window.addEventListener(`pointercancel`, end, { signal });
        window.addEventListener(`keydown`, onKey, { signal });
    };

    /** True once, for the click a drag's own pointerup makes. */
    const consumeClick = (): boolean => {
        const was = suppressClick;
        suppressClick = false;
        return was;
    };

    const isOver = (target: DropTarget): boolean => dragging.value && over.value !== undefined && targetKey(over.value) === targetKey(target);

    onBeforeUnmount(end);

    return { dragged, dragging, ghostStyle, begin, consumeClick, isOver };
}
