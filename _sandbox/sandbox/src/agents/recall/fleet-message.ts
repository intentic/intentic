import { peerMessagePrompt } from "@intentic/sandbox-contract";
import { steerTurn } from "../../agent/checkpoints/agent-steering.js";
import { streamAgent } from "../../agent/routes/agent.routes.js";
import { startConversationTurn } from "../../agent/run/turn/turn-resume.js";
import { conversationRouting } from "../../agent/run/turn/wake-doors.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../registry/agents-store.js";
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

const starts = new Map<string, number[]>();

// True when the sender may start one more turn elsewhere, and books it; prunes its own window as it reads.
const spendTurn = (sender: string, now: number): boolean => {
    const recent = (starts.get(sender) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= TURNS_PER_HOUR) {
        starts.set(sender, recent);
        return false;
    }
    recent.push(now);
    starts.set(sender, recent);
    return true;
};

// The four ways this is refused, as the status each answers with: unusable request, no such conversation, a handle or
// a target that cannot be acted on right now, and a sender past its hourly ceiling.
export type MessageRefusal = 400 | 404 | 409 | 429;

export type MessageOutcome =
    | { readonly ok: true; readonly to: string; readonly delivery: "steered" | "turn"; readonly note: string }
    | { readonly ok: false; readonly status: MessageRefusal; readonly message: string; readonly candidates?: readonly PersistedAgent[] };

type Refused = Extract<MessageOutcome, { ok: false }>;

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
    if (entry.archivedAt !== undefined) {
        return { ok: false, status: 409, message: `\`${entry.id}\` is archived: it is off the board, and a message would quietly start work on it. Ask the owner to reopen it first.` };
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
    const steer = { text: peerMessagePrompt({ from: sender, title: entry.title, message }), voice: "agent", outside: peer } as const;
    // A live turn takes it between tool calls, which costs nothing and lands sooner than a turn of its own would.
    if (steerTurn(entry.id, steer)) {
        services.logger.info({ from, to: entry.id }, "fleet message: steered into the live turn");
        return { ...STEERED, to: entry.id };
    }
    if (!spendTurn(sender, Date.now())) {
        return {
            ok: false,
            status: 429,
            message: `This conversation has started ${TURNS_PER_HOUR} turns on other conversations in the last hour, which is the ceiling. Wait, or ask the owner to carry the message.`,
        };
    }
    const sessionId = services.agents.sessionIdOf(entry.id) ?? entry.sessionId;
    const run = await startConversationTurn(services, streamAgent, {
        ...conversationRouting(entry),
        ...(sessionId === undefined ? {} : { sessionId }),
        conversationId: entry.id,
        prompt: steer.text,
        // Who asked, in the same vocabulary the registry already uses for a spawned child's starter.
        actor: peer,
        // What makes the sandbox treat the turn as carrying somebody else's words rather than the owner's.
        outsideWake: peer,
    });
    if (run === undefined) {
        // A turn is in flight after all: it either started between the steer attempt and this call, or it was already
        // running and unsteerable — parked on a card only its owner can answer, or on a runtime with no steering seam.
        return steerTurn(entry.id, steer)
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
