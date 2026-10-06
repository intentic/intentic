import type { AgentEvent, AgentReply, ParkKind } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import type { MayAnswer, ParkedCards } from "../conversations/actor/parked-cards.js";
import { opt } from "../opt.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../seams/workload-stamp.js";

// A card raised outside the turn generator (an HTTP call mid-turn, a bridged tool call) parks on the conversation's
// live turn: mint the request, push the raised and resolution frames to the run, and mirror them to the conversation's
// actor by hand (the pump never sees an external frame). Each gate owns its offer, refusal text, and what a yes releases.
// Here, below the conversations that implement CardDeps (conversations/actor/card-deps.ts wires the real ones), so a
// gate in a lower layer (secrets, wallet, sandboxes) raises a card without importing the turn engine.

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

// The seams a gate needs for testing: `liveRun` finds the turn to raise a card in (undefined refuses outright);
// `observe` mirrors frames to the conversation's actor, since externally pushed frames bypass the turn pump; `cards`
// parks the card where a reply finds it; `awaiting` tells the owner's devices, as a card the turn raised itself would.
export interface CardDeps {
    readonly liveRun: (conversationId: string | undefined) => LiveCard | undefined;
    readonly observe: (conversationId: string, event: AgentEvent) => void;
    readonly cards: Pick<ParkedCards, "create">;
    readonly awaiting: (conversationId: string, kind: ParkKind) => void;
}

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
    // Whether a person's reply lets the gated action go ahead.
    readonly approves: (reply: Extract<AgentReply, { kind: K }>) => boolean;
    // Who may click, when the card is addressed to a named list rather than to whoever is looking.
    readonly mayAnswer?: MayAnswer;
    // Asks every time: a standing "allow everything" never answers it. A card addressed by mayAnswer always asks too.
    readonly alwaysAsks?: boolean;
    // The caller's own lifetime; its abort settles the card cancelled instead of leaving it parked unattended.
    readonly signal?: AbortSignal;
    readonly deadlineMs: number;
}

export interface SettledCard<K extends AgentReply["kind"]> {
    readonly requestId: string;
    readonly reply: Extract<AgentReply, { kind: K }>;
    // Who answered, when the daemon verified an identity on the reply's request.
    readonly caller: Caller | undefined;
    // `unanswered` is the deadline firing or the caller dying, never a decline, so each gate words it apart.
    readonly decision: "approved" | "declined" | "unanswered";
    // Push a follow-up frame under the settled card, to the run and the registry both.
    readonly say: (event: AgentEvent) => void;
}

// Raises one card and holds the call until it settles; the resolution frame is pushed unconditionally before the caller
// sees the answer, since it is what stops a client rendering the card as live.
export const raiseRequest = async <K extends AgentReply["kind"]>(
    deps: Pick<CardDeps, "observe" | "cards" | "awaiting">,
    run: LiveCard,
    card: Card<K>,
): Promise<SettledCard<K>> => {
    const say = (event: AgentEvent): void => {
        run.push(event);
        deps.observe(run.conversationId, event);
    };
    const alwaysAsks = card.alwaysAsks === true || card.mayAnswer !== undefined;
    const { id, wait } = deps.cards.create(card.kind, card.onAbort, run.conversationId, { ...opt("mayAnswer", card.mayAnswer), alwaysAsks });
    const raised = card.raised(id);
    // The card says so itself, so its Allow menu never offers a yes that would not answer it.
    say(alwaysAsks && raised.kind === "permission" ? { ...raised, alwaysAsks: true } : raised);
    deps.awaiting(run.conversationId, card.kind);
    const deadline = AbortSignal.timeout(card.deadlineMs);
    const { reply, resolved, caller } = await wait(card.signal === undefined ? deadline : AbortSignal.any([card.signal, deadline]));
    say(resolved);
    const decision = resolved.reply === undefined ? "unanswered" : card.approves(reply) ? "approved" : "declined";
    return { requestId: id, reply, caller, decision, say };
};
