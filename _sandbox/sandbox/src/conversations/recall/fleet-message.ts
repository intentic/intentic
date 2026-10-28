import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentHarness, AgentProvider, MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { peerMessagePrompt } from "@intentic/sandbox-contract/events/agent-words";
import { parentOfActor } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import { conversationTaintSource, PEER_SOURCE, taintWords } from "../../guard/turn-taint.js";
import { opt } from "../../opt.js";
import { conversationProfile, type PersistedAgent } from "../registry/agents-store.js";
import { fileStartWindow, type StartWindow, turnStartsDocument } from "../../store/start-window.js";
import { liveRunOf } from "../actor/conversation-holdings.js";
import { AFTER_RUNNING_TURN, releaseHeldBy } from "../queue-waits.js";
import { resolveHandle } from "./fleet-recall.js";
import { trackPeerMessage } from "./fleet-message-outcome.js";
import { followTurns, type MessageWaited, type WaitAsk } from "./fleet-message-wait.js";

// One agent saying something to another conversation in this workspace — the thing a person does by typing into its
// chat, and the one thing an agent could not do. `agents send` reaches only a conversation's own children, and the
// SDK's cross-session messaging reaches only sessions with a live process, which an idle Intentic conversation does not
// have: between them, an agent that needed to tell a peer something had to ask the human to copy a message across.
//
// A message lands the three ways the daemon's own wakes do: steered into a live turn, opening one on the conversation's
// own routing, or queued behind a turn that takes no words. Any way it is a peer's words, never the owner's: drawn as
// the peer's. Whether it taints the turn it lands in depends on who the peer is (messageTaint).

// Ping-pong between two agents is the one way this door spends real money with nobody asking, so each sender gets an
// hourly budget of turns it may START elsewhere. Steering a live turn costs nothing and is not counted. The budget is kept
// on disk (store/start-window.ts), so a restart or a crash loop does not hand out a fresh hour.
const TURNS_PER_HOUR = 20;
// Sender key for a shell that carries no conversation stamp; it is still one budget, not an unbounded one.
const UNSTAMPED = "(unstamped)";

// The window this door's starts are booked in: the history volume's, unless a caller stands one in.
const startWindowOf = (services: Services): StartWindow => fileStartWindow(join(services.config.historyRoot, turnStartsDocument.path));

// How far up the `startedBy` links a family is walked. Nesting is capped far below this; it only stops a corrupt
// registry's loop.
const FAMILY_WALK = 32;

// The conversation a family of spawned agents grew from: up the `startedBy` links to the one a person, a program or the
// sandbox opened. A conversation nobody spawned is its own root.
const rootOf = (entry: (id: string) => PersistedAgent | undefined, id: string): string => {
    let at = id;
    for (let step = 0; step < FAMILY_WALK; step += 1) {
        const parent = parentOfActor(entry(at)?.identity.startedBy);
        if (parent === undefined) {
            return at;
        }
        at = parent;
    }
    return at;
};

export interface MessageTaintDeps {
    readonly entry: (id: string) => PersistedAgent | undefined;
    // What first brought outside content into a conversation's live turn, or undefined for a clean or idle one.
    readonly taintOf: (id: string) => string | undefined;
    // What a sender's runtime is held to: the catalog's answer, unless a test stands in a runtime no loop ships today.
    readonly capabilities?: (provider: AgentProvider, harness: AgentHarness) => Pick<AgentCapabilities, "rulebook">;
}

/**
 * What a message makes of the turn it lands in: the taint source that turn files, or undefined for none.
 *
 * A stranger's words taint it: a conversation outside the target's own family, or a shell with no conversation stamp.
 * Its own family's words (a subagent it started, the parent that started it, a sibling) are the owner's work relayed,
 * read as a child's report is, which taints nothing. Two exceptions carry taint across: a sender whose own live turn took
 * in outside content passes that on, and a sender on a runtime with no permission rules of its own is never clean.
 * Without this a subagent saying "done, here is the diff" to its parent made every later spawn and send in that turn ask
 * the owner, on a card blaming a runtime that had rules.
 */
export const messageTaint = (deps: MessageTaintDeps, from: string | undefined, target: string): string | undefined => {
    if (from === undefined) {
        return "a message from an agent shell outside any conversation";
    }
    const sender = deps.entry(from);
    if (sender === undefined || rootOf(deps.entry, from) !== rootOf(deps.entry, target)) {
        return `${PEER_SOURCE}${from}`;
    }
    const { provider, harness } = sender.profile;
    if ((deps.capabilities ?? capabilitiesOf)(provider, harness).rulebook === "none") {
        return `a message from \`${from}\`, which runs on ${provider}, a runtime with no permission rules of its own`;
    }
    const carried = deps.taintOf(from);
    return carried === undefined ? undefined : `${taintWords(carried)}, relayed by \`${from}\``;
};

// The four ways this is refused, as the status each answers with: unusable request, no such conversation, a handle or
// a target that cannot be acted on right now, and a sender past its hourly ceiling.
export type MessageRefusal = 400 | 404 | 409 | 429;

// What became of a message: said into the live turn (`steered`), a turn of its own opened on the target (`turn`, which
// has not answered yet), or waiting in the target's queue to open one (`queued`).
export type MessageDelivery = "steered" | "turn" | "queued";

export type MessageOutcome =
    | {
          readonly ok: true;
          readonly to: string;
          readonly delivery: MessageDelivery;
          // The run it was said into or opened; absent while it waits in the queue.
          readonly run?: string;
          // The id it went under, which names it in the target's queue and record.
          readonly messageId?: string;
          readonly note: string;
          // With a wait asked for: how the turn it reached ended, or why the wait gave up first.
          readonly waited?: MessageWaited;
      }
    | { readonly ok: false; readonly status: MessageRefusal; readonly message: string; readonly candidates?: readonly PersistedAgent[] };

type Refused = Extract<MessageOutcome, { ok: false }>;
type Delivered = Extract<MessageOutcome, { ok: true }>;

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

/* WHAT THE SENDER IS TOLD, from what the door knows when it answers and nothing it hopes. On 2026-10-28 a sender was told
   "Delivered: a turn on it is starting" about a turn the provider then refused twice, and told its user the turn had
   started. A turn opened is said as opened and not yet answered; one that fails or is held is told to the sender later,
   once (fleet-message-outcome.ts), or by `--wait` as it ends (fleet-message-wait.ts). */

const steered = (to: string, run: string | undefined, messageId?: string): Delivered => ({
    ok: true,
    to,
    delivery: "steered",
    ...opt("run", run),
    ...opt("messageId", messageId),
    note: `Steered: said into its live turn${run === undefined ? "" : ` (run ${run})`}, where it lands between that conversation's tool calls.`,
});

// What comes back of a message that opened a turn, or will: nothing for a shell with no conversation to tell.
const toldLater = (to: string, from: string | undefined): string =>
    from === undefined
        ? `This shell carries no conversation, so nothing comes back of it: \`agents show ${to}\` says how it went.`
        : "If that turn fails or is held, this conversation is told why, once; one that simply finishes says nothing back.";

// Said as opened, not as running: the provider answers after this returns, and the door still judges memory then
// (room-holds.ts). On 2026-10-27 a sender was told "running a turn on it now" five seconds before the door held it for
// five minutes.
const startedNote = (run: string, later: string): string =>
    `Opened a turn on it (run ${run}), which has not answered yet: the provider can still refuse it, and a sandbox short of memory holds it until there is room. ${later}`;

// Why it waits, in the queue's own words (queue-waits.ts).
const queuedNote = (services: Services, to: string, later: string): string => {
    const why = releaseHeldBy(services.conversations, to);
    const behind =
        why === AFTER_RUNNING_TURN
            ? "its running turn takes no words now (it may be parked on a card only its owner can answer), so it goes when that turn ends"
            : (why ?? "it waits in that conversation's queue");
    return `Queued there, not delivered yet: ${behind}. It opens a turn of its own when it goes. ${later}`;
};

// The receipt the door gave, as the sender reads it; a message that opened a turn, or waits to, is followed until that
// turn settles, so the sender hears if it fails or is held.
const deliveredAs = (services: Services, to: string, from: string | undefined, said: { readonly messageId: string; readonly receipt: MessageReceipt; readonly waiting: boolean }): Delivered => {
    const { messageId, receipt, waiting } = said;
    if (receipt.delivered === "steered") {
        return steered(to, receipt.run, messageId);
    }
    if (from !== undefined) {
        trackPeerMessage(services.conversations, { from, to, messageId, ...opt("run", receipt.run), waited: waiting });
    }
    const later = toldLater(to, from);
    services.logger.info({ from, to, run: receipt.run, delivered: receipt.delivered }, "fleet message: a turn on the target conversation is opened or waits to be");
    return receipt.delivered === "started" && receipt.run !== undefined
        ? { ok: true, to, delivery: "turn", run: receipt.run, messageId, note: startedNote(receipt.run, later) }
        : { ok: true, to, delivery: "queued", messageId, note: queuedNote(services, to, later) };
};

// Steered into a live turn for free, else, within the sender's hourly budget, through the door every message nobody at
// the composer typed takes (turn-admission.ts `say`): a turn of its own on the conversation's own routing, or queued
// behind a turn that takes no words or a hold the conversation is under. Queued rather than refused: a turn in flight
// that would not take words was a 409 to try again later until 2026-10-28, and nothing told the sender when later was.
const deliver = async (services: Services, entry: PersistedAgent, from: string | undefined, message: string, starts: StartWindow, waiting: boolean): Promise<MessageOutcome> => {
    const sender = from ?? UNSTAMPED;
    const outside = messageTaint({ entry: (id) => services.agents.entry(id), taintOf: conversationTaintSource }, from, entry.id);
    const text = peerMessagePrompt({ from: sender, title: entry.social.title?.text, message });
    // A live turn takes it between tool calls, which costs nothing and lands sooner than a turn of its own would.
    if ((await services.turns.steer(entry.id, { text, voice: "agent", ...opt("outside", outside) })) === true) {
        services.logger.info({ from, to: entry.id }, "fleet message: steered into the live turn");
        return steered(entry.id, liveRunOf(services.conversations, entry.id)?.id);
    }
    // Booked before the door, which may still steer it into a turn that started meanwhile: a start counted that was not.
    if (!(await starts.spend(`peer:${sender}`, TURNS_PER_HOUR, Date.now()))) {
        return {
            ok: false,
            status: 429,
            message: `This conversation has started ${TURNS_PER_HOUR} turns on other conversations in the last hour, which is the ceiling. Wait, or ask the owner to carry the message.`,
        };
    }
    const messageId = randomUUID();
    const receipt = await services.turns.say({
        voice: "agent",
        // What makes the sandbox treat the turn as carrying somebody else's words rather than the owner's. Absent for its
        // own family's clean words, so a parent its child woke may still spawn and steer children.
        ...opt("outside", outside),
        // On the conversation's own routing, the session it continues decided by the door (turn-admission.ts
        // onCurrentRouting). Who asked, in the same vocabulary the registry already uses for a spawned child's starter.
        turn: { ...conversationProfile(entry), conversationId: entry.id, prompt: text, messageId, actor: `agent:${sender}` },
    });
    if (!("delivered" in receipt)) {
        return "invalid" in receipt ? { ok: false, status: 400, message: receipt.invalid } : archivedRefusal(entry.id);
    }
    return deliveredAs(services, entry.id, from, { messageId, receipt, waiting });
};

/** `from` is absent for an agent shell with no turn stamp; `wait` parks until the turn the message reached settles. */
export const messageConversation = async (
    services: Services,
    from: string | undefined,
    handle: string,
    message: string,
    starts: StartWindow = startWindowOf(services),
    wait?: WaitAsk,
): Promise<MessageOutcome> => {
    const entry = targetOf(services, from, handle);
    if ("ok" in entry) {
        return entry;
    }
    // Listening before the message goes, so a turn that ends before the wait parks is still heard.
    const follow = wait === undefined ? undefined : followTurns(services, entry.id);
    try {
        const outcome = await deliver(services, entry, from, message, starts, wait !== undefined);
        if (!outcome.ok || follow === undefined || wait === undefined) {
            return outcome;
        }
        const reached = { to: outcome.to, run: outcome.run, messageId: outcome.messageId, opened: outcome.delivery !== "steered" };
        return { ...outcome, waited: await follow.until(reached, from, wait) };
    } finally {
        follow?.stop();
    }
};
