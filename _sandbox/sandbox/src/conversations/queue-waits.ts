import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { ConversationActors } from "./actor/conversation-actors.js";
import { liveRunOf } from "./actor/conversation-holdings.js";
import { holdOf, type QueuedItem, waitingOf } from "./actor/conversation-queue.js";
import { windowShut } from "./actor/conversation-state.js";
import { sendableAt } from "./actor/limit-booking.js";

// Why words wait in a conversation's queue rather than go, read off the conversation's own facts: what its admission
// (agent/run/turn/turn-admission.ts) holds them by, and what a release or a peer's queued message
// (conversations/recall/fleet-message.ts) says of it. Here, below both, so neither reaches into the other for it.

type Actors = Pick<ConversationActors, "state" | "queued" | "holdings">;

/** What goes before anything waiting: a recovery the daemon runs by itself, or a rewind restoring files. */
export const goesFirst = (conversations: Pick<ConversationActors, "state">, conversationId: string): boolean => {
    const state = conversations.state(conversationId);
    return state?.turn.resuming === true || state?.phase.kind === "rewinding";
};

/**
 * Whether words nobody at the composer typed must wait rather than open a turn: the conversation is stranded behind a
 * spent allowance whose window is known to be shut. A turn opened there is refused at the door within seconds, and the
 * refusal takes the held turn's place, so the press or the booked resend would then re-run a wake instead of the work,
 * on a fresh session. They wait in the queue and go with the conversation's next turn, or once the window reopens
 * (turn-resume.ts drains them then). A live turn still takes them, and a person's words are never held here: sending is
 * the person's own call.
 */
export const heldBehindLimit = (conversations: Pick<ConversationActors, "state">, conversationId: string, voices: readonly QueuedItem["voice"][]): boolean =>
    voices.every((voice) => voice !== "person") && windowShut(conversations.state(conversationId)?.resume.held, Date.now());

/** The one reason that is not a hold: the words go out after the running turn, which a release's missing `run` says. */
export const AFTER_RUNNING_TURN = "a turn is running and takes no words now: they go after it";

/**
 * Why words still wait though something tried to let them go, in the words its line says it with; undefined when nothing
 * holds them back that the queue can name. A "Send now" that did nothing used to leave no line at all (2026-10-11).
 */
export const releaseHeldBy = (conversations: Actors, conversationId: string): string | undefined => {
    const queue = conversations.queued(conversationId);
    const waiting = waitingOf(queue);
    if (waiting.length === 0) {
        return undefined;
    }
    const held = conversations.state(conversationId)?.resume.held;
    if (heldBehindLimit(conversations, conversationId, waiting.map((item) => item.voice)) && held?.reopensAt !== undefined) {
        const provider = withRuntimeDefaults(held.input).agent;
        return `behind the ${provider} limit until ${new Date(sendableAt(held.reopensAt)).toISOString()}: words nobody at the composer typed wait for it to reopen`;
    }
    if (goesFirst(conversations, conversationId)) {
        return "a recovery or a rewind the sandbox runs by itself goes first";
    }
    const paused = holdOf(queue);
    if (paused !== undefined) {
        return `the queue is still paused (${paused})`;
    }
    if (liveRunOf(conversations, conversationId) !== undefined || conversations.state(conversationId)?.phase.kind === "running") {
        return AFTER_RUNNING_TURN;
    }
    return undefined;
};
