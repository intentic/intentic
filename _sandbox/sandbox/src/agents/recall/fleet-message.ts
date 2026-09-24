import { peerMessagePrompt } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { Holding, Holdings } from "../actor/conversation-holdings.js";
import { conversationProfile, type PersistedAgent } from "../registry/agents-store.js";
import { resolveHandle } from "./fleet-recall.js";

// One agent saying something to another conversation in this workspace — the thing a person does by typing into its
// chat, and the one thing an agent could not do. `agents send` reaches only a conversation's own children, and the
// SDK's cross-session messaging reaches only sessions with a live process, which an idle Intentic conversation does not
// have: between them, an agent that needed to tell a peer something had to ask the human to copy a message across.
//
// A message lands the same two ways the daemon's own wakes do: steered into a live turn, or opening one on the
// conversation's own routing. Either way it is a peer's words, never the owner's: drawn as the peer's and tainting the turn.

// Ping-pong between two agents is the one way this door spends real money with nobody asking, so each sender gets an
// hourly budget of turns it may START elsewhere. Steering a live turn costs nothing and is not counted.
const TURNS_PER_HOUR = 20;
const WINDOW_MS = 3_600_000;
// Sender key for a shell that carries no conversation stamp; it is still one budget, not an unbounded one.
const UNSTAMPED = "(unstamped)";

// When each sender started a turn elsewhere, held by the sender; the unstamped shell's budget is held by none.
const STARTS: Holding<readonly number[]> = { name: "peer turn starts" };

// True when the sender may start one more turn elsewhere, and books it; prunes its own window as it reads.
const spendTurn = (starts: Holdings<readonly number[]>, from: string | undefined, now: number): boolean => {
    const sender = from ?? UNSTAMPED;
    const recent = (starts.get(sender) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= TURNS_PER_HOUR) {
        starts.hold(from, sender, recent);
        return false;
    }
    starts.hold(from, sender, [...recent, now]);
    return true;
};

// The four ways this is refused, as the status each answers with: unusable request, no such conversation, a handle or
// a target that cannot be acted on right now, and a sender past its hourly ceiling.
export type MessageRefusal = 400 | 404 | 409 | 429;

export type MessageOutcome =
    | { readonly ok: true; readonly to: string; readonly delivery: "steered" | "turn"; readonly note: string }
    | { readonly ok: false; readonly status: MessageRefusal; readonly message: string; readonly candidates?: readonly PersistedAgent[] };

type Refused = Extract<MessageOutcome, { ok: false }>;

const archivedRefusal = (id: string): Refused => ({
    ok: false,
    status: 409,
    message: `\`${id}\` is archived: it is off the board, and a message would quietly start work on it. Ask the owner to reopen it first.`,
});

// The conversation a handle names, or why a message cannot go there.
const targetOf = (services: Services, from: string | undefined, handle: string): PersistedAgent | Refused => {
    const resolved = resolveHandle(services, handle);
    if (resolved.kind === "ambiguous") {
        return {
            ok: false,
            status: 409,
            message: `\`${handle}\` matches ${resolved.candidates.length} conversations; name one of them.`,
            candidates: resolved.candidates,
        };
    }
    if (resolved.kind === "unknown") {
        return { ok: false, status: 404, message: `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.` };
    }
    const entry = resolved.entry;
    if (entry.id === from) {
        return { ok: false, status: 400, message: "That is this conversation. A message to yourself is a note; write it down instead." };
    }
    // Asked before the steer and the hourly budget, so a refusal spends neither.
    if (entry.archivedAt !== undefined) {
        return archivedRefusal(entry.id);
    }
    return entry;
};

const STEERED: Omit<Extract<MessageOutcome, { ok: true }>, "to"> = {
    ok: true,
    delivery: "steered",
    note: "Steered: it lands between that conversation's tool calls.",
};

/** `from` is absent for an agent shell with no turn stamp. */
export const messageConversation = async (services: Services, from: string | undefined, handle: string, message: string): Promise<MessageOutcome> => {
    const entry = targetOf(services, from, handle);
    if ("ok" in entry) {
        return entry;
    }
    const sender = from ?? UNSTAMPED;
    const peer = `agent:${sender}`;
    const steer = { text: peerMessagePrompt({ from: sender, title: entry.social.title?.text, message }), voice: "agent", outside: peer } as const;
    // A live turn takes it between tool calls, which costs nothing and lands sooner than a turn of its own would.
    if ((await services.turns.steer(entry.id, steer)) === true) {
        services.logger.info({ from, to: entry.id }, "fleet message: steered into the live turn");
        return { ...STEERED, to: entry.id };
    }
    if (!spendTurn(services.conversations.holdings(STARTS), from, Date.now())) {
        return {
            ok: false,
            status: 429,
            message: `This conversation has started ${TURNS_PER_HOUR} turns on other conversations in the last hour, which is the ceiling. Wait, or ask the owner to carry the message.`,
        };
    }
    const sessionId = services.conversations.sessionIdOf(entry.id) ?? entry.sessionId;
    const run = await services.turns.start({
        ...conversationProfile(entry),
        ...(sessionId === undefined ? {} : { sessionId }),
        conversationId: entry.id,
        prompt: steer.text,
        // Who asked, in the same vocabulary the registry already uses for a spawned child's starter.
        actor: peer,
        byPerson: false,
        // What makes the sandbox treat the turn as carrying somebody else's words rather than the owner's.
        outsideWake: peer,
    });
    if (run === "archived") {
        return archivedRefusal(entry.id);
    }
    if (run === "busy") {
        // A turn is in flight after all: it either started between the steer attempt and this call, or it was already
        // running and unsteerable — parked on a card only its owner can answer, or on a runtime with no steering seam.
        return (await services.turns.steer(entry.id, steer)) === true
            ? { ...STEERED, to: entry.id }
            : {
                  ok: false,
                  status: 409,
                  message: `\`${entry.id}\` has a turn in flight that will not take words right now — it may be parked on a card only its owner can answer. Try again when it settles.`,
              };
    }
    services.logger.info({ from, to: entry.id, run: run.id }, "fleet message: opened a turn on the target conversation");
    return { ok: true, to: entry.id, delivery: "turn", note: "Delivered: that conversation is running a turn on it now." };
};
