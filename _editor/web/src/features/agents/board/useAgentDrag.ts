import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { computed, ref } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { askAgentToResolve, discardAgent, invalidateAgentAction, landAgent, nothingLanded, stopAgent } from "../fleet/agentActions";
import { refreshAcross } from "../../sandbox/live/fleetAcross";
import { otherFleet } from "../fleet/fleetScope";
import { unregistered } from "../fleet/agentStatus";
import { hold, pendingOn } from "../fleet/useAgents-provisional";
import { dropActionFor, type DropAction, type DropTarget, type PendingAction } from "./laneDrop";
import { useAgents } from "../fleet/useAgents";
import { useNotifications } from "../../../shell/notifications/notifications";
import type { FleetAgent } from "../fleet/useAgents-fleet";

// Pointer-driven card drag: Pointer Events (not HTML5 drag-and-drop) give a real AgentCard ghost, Escape-to-cancel, and
// DOM hit-testing for the drop target. A drop never assigns a lane: it runs the action, and the action claims the card
// (useAgents-provisional), so the card moves in the frame of the drop and the roster only confirms it or takes it back.
// Mouse and pen only; touch stacks the lanes instead. Module-level singleton, like useAgents and useChat.

// Far enough that a click with a shaky hand still opens the card.
const DRAG_THRESHOLD_PX = 5;

const { fleet, refresh, notice, stopWatching } = useAgents();
const { say } = useNotifications();

// An id and its box: agent ids are minted per daemon, so the same id can be on two cards from two sandboxes, and
// resolving by id alone could act on the wrong one's card.
const draggedId = ref<string | undefined>(undefined);
const draggedBox = ref<string | undefined>(undefined);
const dragging = ref(false);
const pointer = ref({ x: 0, y: 0 });
const over = ref<DropTarget | undefined>(undefined);
const ghostWidth = ref(0);

// Resolved live against the roster, not snapshotted at grab time, so a turn ending mid-drag retracts its Stop action.
// Read from the roster the card came from (via draggedBox), never from whichever answers to the id first.
const dragged = computed<FleetAgent | undefined>(() =>
    draggedBox.value === undefined
        ? fleet.value.find((agent) => agent.id === draggedId.value)
        : otherFleet.value.find((agent) => agent.id === draggedId.value && agent.sandboxId === draggedBox.value),
);

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

// A drag's pointerup also lands as a click on the source card; the board asks this before opening the agent, the same
// handshake titleEdit uses to protect its blur-commit.
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
    draggedBox.value = undefined;
    dragging.value = false;
    over.value = undefined;
};

// One runner for land and reland: same claim on the card, same refusal notice, same refresh. Only the rung it measures
// from differs, as one argument rather than a parallel path free to drift.
const runLand = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    const result = await landAgent(id, `check`, chosen === `reland` ? `cumulative` : `outstanding`, false, at);
    await invalidateAgentAction(id, at);
    if (!result.landed) {
        // Reachable from an errored card's drop or a ready card's button; either way a first refusal with a report to
        // read, not a repeat.
        notice.value = `Landing hit a conflict: open the agent to see what blocked it.`;
        return;
    }
    if (!result.changed) {
        // Merged with nothing to show for it. The card carries no trace of that either way, so an unsaid one leaves the
        // press looking like it worked; a receipt, not the danger strip, since nothing was refused.
        say(nothingLanded());
    }
};

const runAction = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    if (chosen === `stop`) {
        await stopAgent(id, at);
        return;
    }
    if (chosen === `unwatch`) {
        // The store's own optimistic write moves the card out of Active on press (useAgents.stopWatching), so nothing
        // else is needed here. Refused for a card in another box (laneDrop's NEEDS_THIS_BOX), since this store is the
        // active daemon's roster.
        await stopWatching(id);
        return;
    }
    if (chosen === `land` || chosen === `reland`) {
        await runLand(id, chosen, at);
        return;
    }
    if (chosen === `resolve`) {
        // The turn does the rest: it rebases and resolves, and the auto-land at completion moves the card, so a send
        // that went says nothing here, and neither does one the chat already answered for (`dropped`). A refusal must,
        // since the board can't tell from `status: "conflict"` alone whether it is the user's to clear.
        const ask = await askAgentToResolve(id);
        // A press that put the card right is an outcome, not a failure: it takes the floating receipt, leaving the
        // board's danger strip for the refusals it was written for.
        if (ask.kind === `settled`) {
            say(ask.why);
        }
        if (ask.kind === `refused`) {
            notice.value = ask.why;
        }
        return;
    }
    await discardAgent(id, at);
    await invalidateAgentAction(id, at);
};

// The card doesn't move lane here; the action's claim does, on the press, and the roster frame the action provokes
// confirms it. The action's own layer only withholds a second press on the same card until this one has answered.
const perform = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    // Re-entry on the same card is a no-op, like useAsyncAction's: a card mid-action is pointer-inert.
    if (pendingOn(id, at) !== undefined) {
        return;
    }
    const lift = hold(id, at, { action: chosen });
    notice.value = undefined;
    // After a switch the strip is the next sandbox's, which this press never touched.
    const current = sandboxScopeGuard();
    try {
        await runAction(id, chosen, at);
        // The action's own roster frame is already on its way; this just closes the gap on a quiet stream. Another box
        // has no stream to close, so its re-read is the only thing that moves the card.
        await (at === undefined ? refresh() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        if (current()) {
            notice.value = errorMessage(caught, `That didn't work.`);
        }
    } finally {
        lift();
    }
};

// Stop, land, discard and unwatch act on state this browser already has and are reversible or already confirmed
// elsewhere; `resolve` spends a turn on unseen work from an easily-accidental gesture, so it confirms first. The review
// panel's own button doesn't ask, since a deliberate press there is already the answer.
const pendingResolve = sandboxRef<string | undefined>(() => undefined);

const confirmResolve = (): void => {
    const id = pendingResolve.value;
    pendingResolve.value = undefined;
    if (id !== undefined) {
        void perform(id, `resolve`);
    }
};

const cancelResolve = (): void => {
    pendingResolve.value = undefined;
};

// Shares `perform` with the drop rather than a second implementation, so the claim, notice and refresh can't drift.
// Skips the confirm dialog: a button press, unlike a drag, already states the action it is about to take.
const resolveNow = (id: string, at?: string): Promise<void> => perform(id, `resolve`, at);

// The ready card's "Land now": shares the same runner as resolveNow, with no confirm dialog since landing is reversible
// in the git sense (the branch keeps everything).
const landNow = (id: string, at?: string): Promise<void> => perform(id, `land`, at);

// The way back for a card whose landed work was discarded: same runner, no dialog, since this only restores work
// already reviewed once.
const relandNow = (id: string, at?: string): Promise<void> => perform(id, `reland`, at);

// The fourth press to share `perform`, for a card's own readout rather than the drop or context menu. No dialog: the
// card already names the condition it's ending, and re-arming it is a sentence to the agent.
const unwatchNow = (id: string, at?: string): Promise<void> => perform(id, `unwatch`, at);

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
    const at = draggedBox.value;
    const chosen = action.value;
    cancel();
    if (id === undefined || chosen === undefined) {
        return;
    }
    // The one drop that starts a turn confirms first; `resolve` is refused outright for a card in another box, so the
    // dialog only ever holds a local id.
    if (chosen === `resolve`) {
        pendingResolve.value = id;
        return;
    }
    void perform(id, chosen, at);
};

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        cancel();
    }
};

// Arms a drag on pointerdown; it becomes one only once the pointer travels far enough, so a plain click still opens the
// agent.
const begin = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    // Ahead of every guard: a press on any card ends the previous drag's claim, or the suppression flag would outlive
    // its drag and swallow the next card's first click.
    suppressOpen = false;
    if (event.pointerType === `touch` || event.button !== 0) {
        return;
    }
    // A draft or refused send has no registry entry, so no drop on it could do anything.
    if (unregistered(agent.status)) {
        return;
    }
    const rect = card.getBoundingClientRect();
    grabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    origin = { x: event.clientX, y: event.clientY };
    pointer.value = origin;
    ghostWidth.value = rect.width;
    draggedId.value = agent.id;
    draggedBox.value = agent.sandboxId;
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
    return {
        dragged,
        dragging,
        draggedId,
        draggedBox,
        over,
        action,
        accepts,
        ghostStyle,
        begin,
        consumeSuppressedOpen,
        pendingResolve,
        confirmResolve,
        cancelResolve,
        resolveNow,
        landNow,
        relandNow,
        unwatchNow,
    };
}
