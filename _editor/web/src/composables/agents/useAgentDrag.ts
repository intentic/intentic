import { computed, ref } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { askAgentToResolve, discardAgent, invalidateAgentAction, landAgent, stopAgent } from "./agentActions";
import { refreshAcross } from "../sandbox/fleetAcross";
import { otherFleet } from "./fleetScope";
import { unregistered } from "./agentStatus";
import { dropActionFor, type DropAction, type DropTarget, type PendingAction } from "./laneDrop";
import { useAgents, type FleetAgent } from "./useAgents";

/* Pointer-driven card drag for the board. Pointer Events rather than HTML5 drag-and-drop: the ghost is a real
 * AgentCard instead of a browser drag image, Escape cancels, and the drop target is hit-tested against the
 * live DOM so a scrolled lane still answers correctly.
 *
 * The dragged card STAYS in its lane, dimmed, while a fixed ghost follows the pointer. Nothing changes lane on
 * drop either: the action fires and the daemon's next roster frame moves the card. So the board never paints a
 * lane the status machine disagrees with, which is the whole point of laneOf being a pure projection.
 *
 * Mouse and pen only. Touch is deliberately excluded, a drag would fight the lanes' own scrolling, and the
 * mobile layout stacks the lanes anyway; land and discard stay reachable there from the review panel.
 *
 * Module-level singleton (one board), like useAgents and useChat. */

// Far enough that a click with a shaky hand still opens the card.
const DRAG_THRESHOLD_PX = 5;

const { fleet, refresh, notice, stopWatching } = useAgents();

/* WHICH CARD IS IN FLIGHT, as an id AND the box it is in.
 *
 * An id alone stopped being an identity the day the board could show two sandboxes at once: agent ids are
 * minted per daemon, so a workspace cloned onto a second machine, or the same conversation resumed there, puts
 * the same id on two cards. Resolving by id would then pick whichever half of the fleet was searched first,
 * and a drop meant for the laptop's card would stop, land or discard the desk's. */
const draggedId = ref<string | undefined>(undefined);
const draggedBox = ref<string | undefined>(undefined);
const dragging = ref(false);
const pointer = ref({ x: 0, y: 0 });
const over = ref<DropTarget | undefined>(undefined);
// The one action this board is running, and which card it is running against, the action and not just the id
// because the card's own buttons report their progress in place (see PendingAction).
const busy = ref<{ id: string; at?: string; action: PendingAction } | undefined>(undefined);
const ghostWidth = ref(0);

/* Resolved live against the roster rather than snapshotted at grab time: a turn that ends mid-drag must
 * retract its "Stop the turn" drop instead of letting the user cancel a turn that already finished.
 *
 * Out of the roster the card CAME from, never out of whichever one answers to its id first: see draggedBox. A
 * card from another sandbox that resolved to nothing here would have every drop on it silently refused with no
 * reason to show, and one that resolved to a local namesake would be worse than that. */
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

// A drag's pointerup also lands as a click on the source card, the board asks this before opening the agent,
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
    draggedBox.value = undefined;
    dragging.value = false;
    over.value = undefined;
};

// One runner for both spans, because a re-land IS a land in every way the board cares about, same busy flag,
// same refusal notice, same refresh. What differs is the rung it measures from, and that is one argument rather
// than a parallel path free to drift on the other three.
const runLand = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    const result = await landAgent(id, `check`, chosen === `reland` ? `cumulative` : `outstanding`, false, at);
    await invalidateAgentAction(id, at);
    if (!result.landed) {
        // Reachable from an ERRORED card's drop or a READY card's button (a conflicted one resolves instead),
        // either way a first refusal with a report to read, not the repeat of one the user has already seen. A
        // re-land reaches it when the user's own tree has moved over the paths it is putting back, which is
        // the same report and the same read.
        notice.value = `Landing hit a conflict: open the agent to see what blocked it.`;
    }
};

const runAction = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    if (chosen === `stop`) {
        await stopAgent(id, at);
        return;
    }
    if (chosen === `unwatch`) {
        // The store's own optimistic write moves the card out of Active the moment this is pressed
        // (useAgents.stopWatching), so the drop needs nothing here beyond the call: no report to read, and
        // nothing that can half-succeed. Local by construction: the drop is refused for a card in another box
        // (laneDrop's NEEDS_THIS_BOX), because this store is the active daemon's roster.
        await stopWatching(id);
        return;
    }
    if (chosen === `land` || chosen === `reland`) {
        await runLand(id, chosen, at);
        return;
    }
    if (chosen === `resolve`) {
        // The turn does the rest: it rebases, resolves, and the auto-land at completion moves the card. Its own
        // frames are the progress report, so a send that WENT says nothing here. One that didn't has to: the
        // board is armed off `status: "conflict"` alone, so it cannot know until the report is read that this
        // particular conflict is the user's own to clear (see askAgentToResolve).
        const ask = await askAgentToResolve(id);
        if (!ask.sent) {
            notice.value = ask.why;
        }
        return;
    }
    await discardAgent(id, at);
    await invalidateAgentAction(id, at);
};

// The card doesn't move lane here, the roster frame the action provokes does that. Until it arrives the card
// shows as busy in place, so a slow daemon reads as "working", never as a card teleporting back.
const perform = async (id: string, chosen: PendingAction, at?: string): Promise<void> => {
    busy.value = { id, at, action: chosen };
    notice.value = undefined;
    try {
        await runAction(id, chosen, at);
        /* The action's own roster frame is already on its way; this just closes the gap on a quiet stream.
         *
         * Another box has no stream to close a gap on, so its re-read is the ONLY thing that moves the card:
         * without it a landed card would sit in Attention until the poll's next tick, which is the one place a
         * press on the wider board could read as a press that did nothing. */
        await (at === undefined ? refresh() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        notice.value = errorMessage(caught, `That didn't work.`);
    } finally {
        busy.value = undefined;
    }
};

/* WHY THE RESOLVE DROP ASKS FIRST, and none of the others do.
 *
 * Stop, land, discard and unwatch all act on state this browser already has: what they will do is fully
 * described by the card and the drag hint, and each is either reversible or already carries its own
 * confirmation elsewhere. Unwatch is the cheapest of them to undo, since the agent can be told to watch the
 * same thing again in a sentence, and the card names the condition it is ending before the drop is made.
 * `resolve` STARTS A TURN, it spends the agent's time and the user's money on work nobody has seen the shape
 * of yet, and a drag is the easiest gesture here to make by accident: a card grabbed to be read, released a
 * few pixels into the wrong lane. So it stops at a dialog naming the agent, and the board performs it only
 * when the user says so. The review panel's button doesn't ask, because a deliberate press under a paragraph
 * explaining the mechanics is already the answer this dialog exists to collect.
 *
 * Held as the id alone: by the time the dialog is answered the roster has probably moved, and the confirm
 * should act on the agent that was dropped, not on a snapshot of what it looked like when it was. */
const pendingResolve = ref<string | undefined>(undefined);

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

/* THE SAME ASK, FROM THE CARD'S OWN BUTTON, and deliberately the same runner, not a second one.
 *
 * A conflicted card's press and a conflicted card's drop are one action on one board, so they share `perform`:
 * one busy flag (the card dims in place), one notice strip for a refusal, one refresh closing the gap on a
 * quiet stream. A parallel implementation here would be free to drift on all three, and the first thing to
 * drift would be the report of a failure, the half nobody exercises by hand.
 *
 * It does NOT go through pendingResolve's dialog, and that is the whole difference between the two. The dialog
 * guards a GESTURE: a card grabbed to be read and released a few pixels into the wrong lane starts a turn the
 * user never asked for, and nothing about a drag says what it is about to cost. A press on a button labelled
 * with the action, under a tooltip that states the mechanics, IS the answer that dialog exists to collect,
 * the same reasoning the review panel's own button already rests on. Asking twice for the same intent teaches
 * people to click through dialogs. */
const resolveNow = (id: string, at?: string): Promise<void> => perform(id, `resolve`, at);

// The ready card's "Land now", the same runner for the same reasons resolveNow shares it (one busy flag, one
// notice strip, one refresh). No dialog: landing is reversible in the git sense (the branch keeps everything)
// and the button states its own mechanics, exactly like the review panel's copy of it.
const landNow = (id: string, at?: string): Promise<void> => perform(id, `land`, at);

// The way back for a card whose landed work was discarded from the workspace, the same runner again, one
// argument apart (see perform). No dialog, for the reason the two above have none and one of their own: this
// press UNDOES a destruction rather than causing one, and the only thing it can put in the tree is work the
// user has already reviewed once.
const relandNow = (id: string, at?: string): Promise<void> => perform(id, `reland`, at);

/* THE WAY OFF A WATCH, from the card's own readout, and the fourth press to share `perform` for the reasons
 * the three above give: one busy flag, one notice strip, one refresh, and a refusal reported the same way
 * whichever gesture asked.
 *
 * It exists because the drop and the context menu were the whole of it, and both are gestures a user has to
 * already know about: the card SAID it was watching, in the one place the eye lands, and that readout was the
 * only thing on it that could not be acted on. No dialog, and this is the clearest case on the board for
 * having none: the card names the condition it is ending, the wait is the only thing lost, and re-arming it is
 * a sentence to the agent. */
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
    // The one drop that starts a turn stops for an answer first; the rest go straight through. `resolve` is
    // refused outright for a card in another box (laneDrop), so the dialog only ever holds a local id.
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

// Arms a drag on the card's pointerdown, it only becomes one once the pointer travels far enough, so a plain
// click still opens the agent and the rename affordances keep their own gestures.
const begin = (event: PointerEvent, agent: FleetAgent, card: HTMLElement): void => {
    // Ahead of every guard: a press on ANY card ends the previous drag's claim on the next click. A drop onto
    // another lane never delivers that click to the source card, so the flag would otherwise outlive its drag
    // and swallow the first click on a card this function declines to drag (a draft, say).
    suppressOpen = false;
    if (event.pointerType === `touch` || event.button !== 0) {
        return;
    }
    // A draft is an open tab that never ran, and a refused one never got past the door, no registry entry
    // either way, so no drop on it could do anything.
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
        busy,
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
