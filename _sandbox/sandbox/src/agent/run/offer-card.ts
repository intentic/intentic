import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { Caller } from "../../auth/auth.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../platform/boot/leftovers.js";
import { createRequest, type MayAnswer } from "../tools/agent-requests.js";
import { soleLiveConversation, turnRunOf } from "./turn/turn-runs.js";

/* AN OFFER CARD is a card raised from OUTSIDE the turn generator: the agent's CLI call arrives as an HTTP
 * request while the turn sits inside its Bash tool, or a tool call crosses a bridge on its way to somebody's
 * laptop, and the daemon parks that call on a card in the conversation's live turn. Five gates do it (a
 * payment, a capability ask, a gated credential, a command headed for a machine), and
 * the plumbing under all five is this one shape: find the live run the caller may draw in, mint the request,
 * push the raised frame into the run's frame log AND mirror it to the registry by hand (the pump's own
 * parked-card journalling never sees an externally pushed frame, deliberately: the waiter is a held
 * connection that dies with the daemon, and a restored card would offer buttons nothing waits behind), wait
 * with a deadline, push the resolution frame the same way, and tell an answer from the abort stand-in.
 *
 * What a gate still owns is everything on the card that is judgment rather than plumbing: its offer, its
 * refusal sentences, what a yes releases, and the receipt it writes under the settled card. */

// How long an unanswered offer holds the agent's call before settling as "nobody answered". Long enough for an
// owner who stepped away from a chat they are in; bounded so an unattended turn's offer cannot park forever.
export const OFFER_DEADLINE_MS = 10 * 60_000;

// The agent's why, capped: one line of rationale is the card's design, not a second request body.
const WHY_MAX = 280;

export const whyOf = (why: string | undefined): { readonly why?: string } => (why !== undefined && why !== "" ? { why: why.slice(0, WHY_MAX) } : {});

// The live turn a card lands in: which conversation, and where its frames go.
export interface LiveCard {
    readonly conversationId: string;
    readonly push: (event: AgentEvent) => void;
}

/* THE TWO SEAMS EVERY GATE TAKES, so its tests drive it with a fake turn and no registry. `liveRun` is the
 * named conversation's run, or, when the caller could not name one, the sole live run; undefined refuses the
 * offer outright. `observe` is the registry's frame observer (agents-registry.ts): externally pushed frames
 * bypass the turn pump that usually feeds it, so a gate mirrors its own frames there to light and clear the
 * Attention lane. */
export interface CardDeps {
    readonly liveRun: (conversationId: string | undefined) => LiveCard | undefined;
    readonly observe: (conversationId: string, event: AgentEvent) => void;
}

// The real `liveRun`, over turn-runs.ts: `soleLiveConversation` covers the door where the caller could not
// name a conversation and exactly one is running, and refuses to guess between two.
export const liveCardRun = (conversationId: string | undefined): LiveCard | undefined => {
    const id = conversationId ?? soleLiveConversation();
    const run = id === undefined ? undefined : turnRunOf(id);
    return id === undefined || run === undefined || run.done ? undefined : { conversationId: id, push: (event) => run.push(event) };
};

// The run a caller may raise a card in, from the conversation its shell was stamped with (INTENTIC_TURN_OWNER).
// The two reserved owner names are "no conversation" here: a pooled process or a one-shot has no chat to
// draw a card in, and the sole live run is what it gets, if there is one.
export const cardRun = (deps: Pick<CardDeps, "liveRun">, conversationId: string | undefined): LiveCard | undefined =>
    deps.liveRun(conversationId === DAEMON_OWNER || conversationId === ONE_SHOT_OWNER ? undefined : conversationId);

export interface Card<K extends AgentReply["kind"]> {
    readonly kind: K;
    // The reply synthesized when the card settles without a person: `requestId: ""` is the registry's
    // convention (it fills in the real id), and the no in it is what makes an aborted call read honestly.
    readonly onAbort: Extract<AgentReply, { kind: K }>;
    // The frame that draws the card, built around the minted id.
    readonly raised: (requestId: string) => AgentEvent;
    // Who may click, when the card is addressed to a named list rather than to whoever is looking.
    readonly mayAnswer?: MayAnswer;
    // Buzz the owner's devices once the card is up, for the one card that waits for somebody who may not
    // know a turn is running.
    readonly notify?: (conversationId: string) => void;
    // The caller's own lifetime (a held CLI connection): its abort settles the card cancelled instead of
    // leaving it parked in a conversation nothing waits behind.
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
}

export interface SettledCard<K extends AgentReply["kind"]> {
    readonly requestId: string;
    readonly reply: Extract<AgentReply, { kind: K }>;
    // Who answered, when the daemon verified an identity on the reply's request (agent-requests.ts).
    readonly caller: Caller | undefined;
    /* WHETHER A PERSON ANSWERED AT ALL. False is the abort stand-in (the deadline fired, or the caller died
     * under the card), and a gate reading that as "the owner declined" would put words in the mouth of
     * somebody who never saw the card: the two no's earn different sentences everywhere. */
    readonly answered: boolean;
    // Push a follow-up frame under the settled card (a receipt, an outcome), to the run and the registry both.
    readonly say: (event: AgentEvent) => void;
}

// Raise one card and hold the call until it settles. Every parked card owes the stream its resolution frame:
// it is what stops a client rendering the card as live, and the only honest account of how long the call was
// parked, so it is pushed here, unconditionally, before the caller sees the answer.
export const raiseCard = async <K extends AgentReply["kind"]>(deps: Pick<CardDeps, "observe">, run: LiveCard, card: Card<K>): Promise<SettledCard<K>> => {
    const say = (event: AgentEvent): void => {
        run.push(event);
        deps.observe(run.conversationId, event);
    };
    const { id, wait } = createRequest(card.kind, card.onAbort, run.conversationId, card.mayAnswer === undefined ? {} : { mayAnswer: card.mayAnswer });
    say(card.raised(id));
    card.notify?.(run.conversationId);
    const deadline = AbortSignal.timeout(card.deadlineMs);
    const { reply, resolved, caller } = await wait(card.signal === undefined ? deadline : AbortSignal.any([card.signal, deadline]));
    say(resolved);
    return { requestId: id, reply, caller, answered: resolved.reply !== undefined, say };
};
