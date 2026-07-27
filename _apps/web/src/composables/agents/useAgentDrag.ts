import { computed, ref } from "vue";
import { errorMessage } from "../useAsyncAction";
import { discardAgent, invalidateAgentAction, landAgent, stopAgent } from "./agentActions";
import { dropActionFor, type DropAction, type DropTarget } from "./laneDrop";
import { useAgents, type FleetAgent } from "./useAgents";

/* Pointer-driven card drag for the board. Pointer Events rather than HTML5 drag-and-drop: the ghost is a real
 * AgentCard instead of a browser drag image, Escape cancels, and the drop target is hit-tested against the
 * live DOM so a scrolled lane still answers correctly.
 *
 * The dragged card STAYS in its lane, dimmed, while a fixed ghost follows the pointer — the lane's
 * TransitionGroup is never asked to FLIP a child that is already moving. Nothing changes lane on drop either:
 * the action fires and the daemon's next roster frame moves the card. So the board never paints a lane the
 * status machine disagrees with, which is the whole point of laneOf being a pure projection.
 *
 * Mouse and pen only. Touch is deliberately excluded — a drag would fight the lanes' own scrolling, and the
 * mobile layout stacks the lanes anyway; land and discard stay reachable there from the review panel.
 *
 * Module-level singleton (one board), like useAgents and useChat. */

// Far enough that a click with a shaky hand still opens the card.
const DRAG_THRESHOLD_PX = 5;

const { fleet, refresh, notice } = useAgents();

const draggedId = ref<string | undefined>(undefined);
const dragging = ref(false);
const pointer = ref({ x: 0, y: 0 });
const over = ref<DropTarget | undefined>(undefined);
const busyId = ref<string | undefined>(undefined);
const ghostWidth = ref(0);

// Resolved live against the roster rather than snapshotted at grab time: a turn that ends mid-drag must
// retract its "Stop the turn" drop instead of letting the user cancel a turn that already finished.
const dragged = computed<FleetAgent | undefined>(() => fleet.value.find((agent) => agent.id === draggedId.value));

const action = computed<DropAction | undefined>(() =>
    dragged.value === undefined || over.value === undefined ? undefined : dropActionFor(dragged.value, over.value),
);

// Does this target accept the card in flight? Drives every lane's droppable affordance.
const accepts = (target: DropTarget): boolean => dragged.value !== undefined && dropActionFor(dragged.value, target) !== undefined;

// The ghost rides the pointer from the point the card was grabbed, so it doesn't jump under the cursor.
let grabOffset = { x: 0, y: 0 };
let origin = { x: 0, y: 0 };
let listeners: AbortController | undefined;
let suppressOpen = false;

const ghostStyle = computed(() => ({
    width: `${ghostWidth.value}px`,
    transform: `translate3d(${pointer.value.x - grabOffset.x}px, ${pointer.value.y - grabOffset.y}px, 0)`,
}));

// A drag's pointerup also lands as a click on the source card — the board asks this before opening the agent,
// the same handshake titleEdit uses to protect its blur-commit.
const consumeSuppressedOpen = (): boolean => {
    if (!suppressOpen) {
        return false;
    }
    suppressOpen = false;
    return true;
};

// The ghost is pointer-events:none, so the board underneath answers the hit test.
const targetAt = (x: number, y: number): DropTarget | undefined => {
    const zone = document.elementFromPoint(x, y)?.closest(`[data-drop]`);
    const value = zone instanceof HTMLElement ? zone.dataset[`drop`] : undefined;
    return value === `attention` || value === `active` || value === `finished` || value === `discard` ? value : undefined;
};

const cancel = (): void => {
    listeners?.abort();
    listeners = undefined;
    draggedId.value = undefined;
    dragging.value = false;
    over.value = undefined;
};

// The card doesn't move lane here — the roster frame the action provokes does that. Until it arrives the card
// shows as busy in place, so a slow daemon reads as "working", never as a card teleporting back.
const perform = async (id: string, chosen: DropAction): Promise<void> => {
    busyId.value = id;
    notice.value = undefined;
    try {
        if (chosen === `stop`) {
            await stopAgent(id);
        } else if (chosen === `land`) {
            const result = await landAgent(id);
            await invalidateAgentAction(id);
            if (!result.landed) {
                notice.value = { message: `Landing hit a conflict — open the agent to resolve it.`, tone: `error` };
            }
        } else {
            await discardAgent(id);
            await invalidateAgentAction(id);
        }
        // The action's own roster frame is already on its way; this just closes the gap on a quiet stream.
        await refresh();
    } catch (caught) {
        notice.value = { message: errorMessage(caught, `That didn't work.`), tone: `error` };
    } finally {
        busyId.value = undefined;
    }
};

const onMove = (event: PointerEvent): void => {
    pointer.value = { x: event.clientX, y: event.clientY };
    if (!dragging.value) {
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) {
            return;
        }
        dragging.value = true;
        suppressOpen = true;
    }
    // Without this a press-and-drag paints a text selection across the whole board.
    event.preventDefault();
    over.value = targetAt(event.clientX, event.clientY);
};

const onUp = (): void => {
    const id = draggedId.value;
    const chosen = action.value;
    cancel();
    if (id !== undefined && chosen !== undefined) {
        void perform(id, chosen);
    }
};

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        cancel();
    }
};

// Arms a drag on the card's pointerdown — it only becomes one once the pointer travels far enough, so a plain
// click still opens the agent and the rename affordances keep their own gestures.
const begin = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    // Ahead of every guard: a press on ANY card ends the previous drag's claim on the next click. A drop onto
    // another lane never delivers that click to the source card, so the flag would otherwise outlive its drag
    // and swallow the first click on a card this function declines to drag (a draft, say).
    suppressOpen = false;
    if (event.pointerType === `touch` || event.button !== 0) {
        return;
    }
    // A draft is an open tab that never ran — no registry entry, so no drop on it could do anything.
    if (agent.status === `draft`) {
        return;
    }
    const rect = card.getBoundingClientRect();
    grabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    origin = { x: event.clientX, y: event.clientY };
    pointer.value = origin;
    ghostWidth.value = rect.width;
    draggedId.value = agent.id;
    dragging.value = false;
    notice.value = undefined;
    listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener(`pointermove`, onMove, { signal });
    window.addEventListener(`pointerup`, onUp, { signal });
    window.addEventListener(`pointercancel`, cancel, { signal });
    window.addEventListener(`keydown`, onKey, { signal });
};

export function useAgentDrag() {
    return { dragged, dragging, draggedId, over, action, accepts, busyId, ghostStyle, begin, consumeSuppressedOpen };
}
