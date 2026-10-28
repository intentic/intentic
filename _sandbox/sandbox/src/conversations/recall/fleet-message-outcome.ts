import { oneLine } from "@intentic/base/one-line";
import type { AgentNext } from "@intentic/sandbox-contract/schemas/agent-next";
import { supervisorOf } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { deliverWake } from "../../seams/wake-delivery.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import type { HeldRecord } from "../actor/conversation-state.js";
import { type Holding, turnRunOf } from "../actor/conversation-holdings.js";
import { conversationProfile } from "../registry/agents-store.js";

// How the turn a peer's message opened ended, told back to the conversation that sent it. On 2026-10-28 `agents message
// deft-reef-zwn8` answered that a turn on it was starting; the provider refused that turn (the account's organisation had
// switched Claude Code off), the sandbox sent it again, it was refused again, and the sender, told nothing more, told its
// user the turn had started. Now a turn the message opened that fails or is held wakes the sender once, saying why and
// what would let it go. A turn that simply finishes wakes nobody: the target answers for itself, with `agents message`.

type Settled = DomainEventMap["run.settled"];

// A message that opened a turn on another conversation, or waits in its queue to open one, until that turn settles.
interface PeerMessage {
    readonly from: string;
    readonly to: string;
    readonly messageId: string;
    // The run it opened; absent while it waits in the target's queue, until the run it goes in carries it (reachedBy).
    readonly run?: string;
    // An `agents message --wait` is parked on it and hands the ending over itself, so the sender is not told twice.
    readonly waited: boolean;
}

// Held by the target, about the sender: either one's dispose takes it. In memory only: a daemon restart forgets what
// it was following, and the sender then hears nothing, as before this existed.
const PEER_MESSAGES: Holding<PeerMessage> = { name: "peer messages awaiting their turn" };

type Actors = Pick<ConversationActors, "holdings">;

/** Follows a message that opened a turn, or waits to open one, until that turn settles. */
export const trackPeerMessage = (actors: Actors, message: PeerMessage): void => {
    actors.holdings(PEER_MESSAGES).hold(message.to, message.messageId, message, message.from);
};

/** The wait on a message gave up before its turn ended (a timeout, words said into the sender's turn): an ending still
 *  to come is the sender's news again. */
export const waitLetGo = (actors: Actors, messageId: string): void => {
    const held = actors.holdings(PEER_MESSAGES);
    const message = held.get(messageId);
    if (message !== undefined) {
        held.hold(message.to, messageId, { ...message, waited: false }, message.from);
    }
};

/**
 * Whether the run that just settled is the one a message reached, and if so whether the message opened it; undefined
 * for another run. A message that waited in the queue names no run, so the settled run's own rows are read for it,
 * while that run is still the conversation's: the first message a run carries opened it, and any later one was said
 * into it.
 */
export const reachedBy = (
    actors: Pick<ConversationActors, "holdings">,
    message: { readonly to: string; readonly messageId?: string | undefined; readonly run?: string | undefined; readonly opened: boolean },
    settledRun: string,
): { readonly opened: boolean } | undefined => {
    if (message.run !== undefined) {
        return message.run === settledRun ? { opened: message.opened } : undefined;
    }
    const run = turnRunOf(actors, message.to);
    if (run?.id !== settledRun || message.messageId === undefined) {
        return undefined;
    }
    const said = run.rows.filter((row) => row.role === "user" && row.messageId !== undefined);
    const at = said.findIndex((row) => row.messageId === message.messageId);
    return at === -1 ? undefined : { opened: at === 0 };
};

// The walls the sandbox sends a held turn past again by itself, on a clock of its own (turn-resume.ts RUNGS), and on what.
// Every other hold waits for a press, but a spent allowance's booked re-run and a wait for memory, which `next` says.
const RETRIED = new Map<HeldRecord["reason"], string>([
    ["auth", "once the account's sign-in is renewed"],
    ["outage", "once the provider answers again"],
    ["stopped", "a few times, since its runtime died under it"],
    ["overflow", "with less of its context"],
]);

// An instant as a UTC clock time, the way the sandbox's other re-run notes say it.
const clock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// A re-run the sandbox booked for the held turn, at its allowance's reopen or onto another account; undefined for none.
const rerunWords = (to: string, next: AgentNext | undefined, rerun: Settled["rerun"]): string | undefined => {
    const booked = next?.kind === "rerun" ? next : undefined;
    if (booked === undefined && rerun === undefined) {
        return undefined;
    }
    const at = booked?.at ?? (rerun?.at === undefined ? undefined : rerun.at * 1000);
    const when = at === undefined || at <= Date.now() ? "shortly" : `at ${clock(at)}`;
    const onto = booked?.onto === undefined ? "" : ` on the account \`${booked.onto}\``;
    return `It is held, and the sandbox sends it again by itself ${when}${onto}. \`agents show ${to}\` says how that goes.`;
};

// A hold the sandbox tries past by itself, or one only a press lets go; undefined when nothing holds the turn.
const heldWords = (to: string, held: HeldRecord | undefined): string | undefined => {
    if (held === undefined || held.fired) {
        return undefined;
    }
    const retried = RETRIED.get(held.reason);
    if (retried !== undefined) {
        return `It is held, and the sandbox sends it again by itself ${retried}. \`agents show ${to}\` says how that goes.`;
    }
    const provider = held.input.agent ?? "the provider that refused it";
    return `It is held there until somebody presses its Continue: \`agents resume ${to}\` sends it again, and \`--provider <id> --model <id>\` moves it off ${provider} (\`agents providers\` lists what has room). Otherwise tell your user what refused it.`;
};

/**
 * What holds the conversation's turn after it failed, or what would let it go: a re-run the sandbox booked, a wait for
 * memory, a hold it tries past by itself or only a press releases, or nothing at all. Read at the settle itself, before
 * the next turn wipes the hold it reads.
 */
export const holdingWords = (services: Pick<Services, "agents" | "conversations">, settled: Pick<Settled, "conversationId" | "rerun">): string => {
    const to = settled.conversationId;
    const next = services.agents.get(to)?.next;
    const room = next?.kind === "room" ? "It is held until the sandbox has memory to spare, and goes by itself then." : undefined;
    return (
        rerunWords(to, next, settled.rerun) ??
        room ??
        heldWords(to, services.conversations.state(to)?.resume.held) ??
        `Nothing sends it again by itself: say it again with \`agents message ${to}\` once what refused it is fixed, or tell your user.`
    );
};

// Characters of the provider's reason the note carries: a sentence or two, not a stack.
const REASON_CHARS = 600;

/** The note the sender wakes to: the turn its message opened did not run, or failed partway, and what holds it now. */
export const peerOutcomePrompt = (fields: { readonly to: string; readonly failure: string; readonly ranNothing: boolean; readonly holding: string }): string =>
    [
        fields.ranNothing
            ? `Your message to \`${fields.to}\` did not run: ${oneLine(fields.failure, REASON_CHARS)}`
            : `The turn your message opened on \`${fields.to}\` failed partway: ${oneLine(fields.failure, REASON_CHARS)}`,
        fields.holding,
        `This note is the sandbox's, sent once; \`${fields.to}\` itself said nothing back. If you told your user it was under way, tell them it is not.`,
    ].join("\n\n");

// Whether the run never reached the model: turned away at the door, its words kept rather than recorded.
const ranNothing = (services: Pick<Services, "conversations">, settled: Settled): boolean => {
    const run = turnRunOf(services.conversations, settled.conversationId);
    return run?.id === settled.run && run.ranNothing;
};

// The sender to wake, or undefined: a message that only steered, one a wait is handing over, a turn that did not fail,
// a sender that is gone, and one that supervises the target, whose subagent's report already says how it ended
// (child-report.ts), are nobody's news.
const senderToWake = (services: Pick<Services, "agents">, message: PeerMessage, opened: boolean, settled: Settled): string | undefined => {
    const target = services.agents.entry(message.to);
    if (!opened || message.waited || settled.failure === undefined || services.agents.entry(message.from) === undefined) {
        return undefined;
    }
    return target !== undefined && supervisorOf(target.identity) === message.from ? undefined : message.from;
};

/**
 * Off every settled run: the messages that opened it, or were waiting to, stop being followed, and the sender of one
 * whose turn failed or is held is told once. The wake is the sandbox's own words, so the turn it opens on the sender is no
 * peer message and nothing it does wakes anybody back; nor does it spend the sender's hourly start budget. Never throws:
 * it runs off a turn's ending.
 */
export const reportPeerMessageOutcome = async (services: Services, settled: Settled): Promise<void> => {
    try {
        const followed = services.conversations.holdings(PEER_MESSAGES);
        // All of it decided in the breath the settle is announced in: the next turn's start, which the drain makes only
        // after, wipes the hold these words describe, and a wait parked on the message hears the same announcement.
        const told = followed.of(settled.conversationId).flatMap((message) => {
            const reached = reachedBy(services.conversations, { ...message, opened: true }, settled.run);
            if (reached === undefined) {
                return [];
            }
            // Taken whatever comes of it: once per message.
            followed.drop(message.messageId);
            const sender = senderToWake(services, message, reached.opened, settled);
            return sender === undefined || settled.failure === undefined
                ? []
                : [{ sender, message, prompt: peerOutcomePrompt({ to: message.to, failure: settled.failure, ranNothing: ranNothing(services, settled), holding: holdingWords(services, settled) }) }];
        });
        for (const { sender, message, prompt } of told) {
            await wakeSender(services, sender, prompt, message);
        }
    } catch (error) {
        services.logger.warn({ err: error, conversationId: settled.conversationId }, "peer message: its outcome could not be told to the sender");
    }
};

// One wake, through the door every wake takes: said into the sender's live turn, a turn of its own, or queued.
const wakeSender = async (services: Services, sender: string, prompt: string, message: PeerMessage): Promise<void> => {
    const entry = services.agents.entry(sender);
    if (entry === undefined) {
        return;
    }
    const receipt = await deliverWake(
        { turns: services.turns },
        { conversationId: sender, prompt, voice: "sandbox", profile: conversationProfile(entry), source: "agents message" },
    );
    const where = "delivered" in receipt ? receipt.delivered : "why" in receipt ? receipt.why : receipt.invalid;
    services.logger.info({ from: sender, to: message.to, messageId: message.messageId, delivered: where }, "peer message: its sender was told how its turn ended");
};
