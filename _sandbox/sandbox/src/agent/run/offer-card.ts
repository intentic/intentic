import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { Caller } from "../../auth/auth.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../platform/boot/leftovers.js";
import { createRequest, type MayAnswer } from "../tools/agent-requests.js";
import { soleLiveConversation, turnRunOf } from "./turn/turn-runs.js";

// A card raised outside the turn generator (an HTTP call mid-turn, a bridged tool call) parks on the conversation's
// live turn: mint the request, push the raised and resolution frames to the run, and mirror them to the registry by
// hand (the pump never sees an external frame). Each gate owns its offer, refusal text, and what a yes releases.

// How long an unanswered offer waits before settling as unanswered; bounds how long an unattended turn can park.
export const OFFER_DEADLINE_MS = 10 * 60_000;

// Cap on the agent's rationale string on a card: one line of reasoning, not a second request body.
const WHY_MAX = 280;

export const whyOf = (why: string | undefined): { readonly why?: string } => (why !== undefined && why !== "" ? { why: why.slice(0, WHY_MAX) } : {});

// The live turn a card lands in: which conversation, and where to push its frames.
export interface LiveCard {
    readonly conversationId: string;
    readonly push: (event: AgentEvent) => void;
}

// The two seams a gate needs for testing: `liveRun` finds the turn to raise a card in (undefined refuses outright);
// `observe` mirrors frames to the registry, since externally pushed frames bypass the turn pump.
export interface CardDeps {
    readonly liveRun: (conversationId: string | undefined) => LiveCard | undefined;
    readonly observe: (conversationId: string, event: AgentEvent) => void;
}

// The real `liveRun`: falls back to the sole live conversation when the caller named none, and refuses to guess between
// two live runs.
export const liveCardRun = (conversationId: string | undefined): LiveCard | undefined => {
    const id = conversationId ?? soleLiveConversation();
    const run = id === undefined ? undefined : turnRunOf(id);
    return id === undefined || run === undefined || run.done ? undefined : { conversationId: id, push: (event) => run.push(event) };
};

// The run a caller may raise a card in. The two reserved owner names (pooled process, one-shot) mean 'no conversation';
// such a caller gets the sole live run, if there is one.
export const cardRun = (deps: Pick<CardDeps, "liveRun">, conversationId: string | undefined): LiveCard | undefined =>
    deps.liveRun(conversationId === DAEMON_OWNER || conversationId === ONE_SHOT_OWNER ? undefined : conversationId);

export interface Card<K extends AgentReply["kind"]> {
    readonly kind: K;
    // The reply synthesized when the card settles unanswered; `requestId` is filled in by the registry.
    readonly onAbort: Extract<AgentReply, { kind: K }>;
    // The frame that draws the card, built around the minted request id.
    readonly raised: (requestId: string) => AgentEvent;
    // Who may click, when the card is addressed to a named list rather than to whoever is looking.
    readonly mayAnswer?: MayAnswer;
    // Buzz the owner's devices once the card is up, for someone who may not know a turn is running.
    readonly notify?: (conversationId: string) => void;
    // The caller's own lifetime; its abort settles the card cancelled instead of leaving it parked unattended.
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
}

export interface SettledCard<K extends AgentReply["kind"]> {
    readonly requestId: string;
    readonly reply: Extract<AgentReply, { kind: K }>;
    // Who answered, when the daemon verified an identity on the reply's request.
    readonly caller: Caller | undefined;
    // Whether a person answered at all: false is the deadline firing or the caller dying, never a decline.
    readonly answered: boolean;
    // Push a follow-up frame under the settled card, to the run and the registry both.
    readonly say: (event: AgentEvent) => void;
}

// Raises one card and holds the call until it settles; the resolution frame is pushed unconditionally before the caller
// sees the answer, since it is what stops a client rendering the card as live.
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
