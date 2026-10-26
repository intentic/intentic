import { type AgentTurn, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { HandedOff, HandoffMode, HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Services } from "../../../../composition.js";
import { type Routing, routingFor, sameLoop } from "../../../../conversations/registry/routing.js";
import type { RoutedTurn } from "../../../../seams/turn-starter.js";
import { opt } from "../../../../opt.js";
import type { HeldTurn } from "./held-turn.js";

/* HOW A TURN GOES ON FROM THE HELD TURN IT TAKES THE PLACE OF. Every turn that begins supersedes whatever this
   conversation held (a spent allowance, a dead runtime), and a spent allowance's hold may carry a choice of ways on
   once the cache is cold (agent/providers/limit-handoff.ts). A press re-runs the held turn the way handoffFor names,
   and the re-run says it with the note it was sent with (turn-resume.ts handoffNote). Words that take the held turn's
   place instead (a person's message, a send booked for the reset, a wake) go on the hold's own pick, the person's else
   the sandbox's suggestion, read for wherever those words go. Until 2026-10-26 they went on the old session whole
   whatever the card said: a "Continue" booked for the reset, sent under a card reading Summary, re-read the whole cold
   session and no summary was written. */

// Where a press sends the held turn, by the one routing rule (conversations/registry/routing.ts), with the held turn's own
// routing as the profile: naming no account keeps the held turn's on its provider, since only a person's explicit pick
// (switchAccount, or an older editor's `account`) moves a conversation to another account.
// A held turn is a stored copy, which a turn written before the port routed it may have left unnamed.
export const pressed = (held: AgentTurn, routing: ResumeRouting): Routing => {
    const { agent: provider, harness, account } = withRuntimeDefaults(held);
    return routingFor({ provider, harness, account }, routing);
};

// Whether the press keeps the held turn's runtime (provider and loop), whatever it does to the account. Compared as loops,
// so a press naming the other name of the same runtime keeps the session.
export const sameRuntime = (input: AgentTurn, routing: ResumeRouting): boolean => {
    const where = pressed(input, routing);
    const held = withRuntimeDefaults(input);
    return where.provider === held.agent && sameLoop({ provider: held.agent, harness: held.harness }, where.harness);
};

// The ways on a spent allowance's held turn can take where it is going: carrying or trimming the session needs the turn
// to have run, its session not refused, and the press to keep its runtime; a summary goes anywhere.
const handoffCan = (held: HeldTurn, routing: ResumeRouting | undefined, offer: HandoffOffer, mode: HandoffMode): boolean => {
    if (offer[mode] === undefined) {
        return false;
    }
    return mode === "summary" || (held.ran && held.carryRefused !== true && (routing === undefined || sameRuntime(held.input, routing)));
};

// Which way a held turn the owner had a choice for continues: the press's own word, else the person's pick on the card,
// else an older editor's `carry`, else the suggestion the card showed. A way the destination cannot take (another
// provider holds no session) falls to a summary, then a trim, then carrying, whichever the offer has. Undefined for a
// hold with no offer, which goes on as it always has.
export const handoffFor = (held: HeldTurn, routing: ResumeRouting | undefined): HandoffMode | undefined => {
    const offer = held.reason === "limit" ? held.handoff : undefined;
    if (offer === undefined) {
        return undefined;
    }
    const asked = routing?.handoff ?? offer.chosen ?? (routing?.carry === true ? "carry" : undefined) ?? offer.suggested;
    const can = (mode: HandoffMode): boolean => handoffCan(held, routing, offer, mode);
    return can(asked) ? asked : (["summary", "trim", "carry"] as const).find(can);
};

/** The held turn a turn takes the place of, superseded as it begins, and the way it goes on from it. */
export interface Replaced {
    readonly held: HeldTurn | undefined;
    readonly way: HandoffMode | undefined;
}

/** Which way a turn continues the held turn it replaces; undefined for none. */
export const handoffWayOf = (input: RoutedTurn, held: HeldTurn | undefined): HandoffMode | undefined => {
    switch (input.resume) {
        case "summarized":
            return "summary";
        case "trimmed":
            return "trim";
        // A re-run that resumes its session: carrying, where carrying was one way among others.
        case "limit":
        case "carried":
            return held?.handoff === undefined ? undefined : "carry";
        // New words: the hold's pick, where a spent allowance left one, as a press onto this routing would take it.
        case undefined:
            return held?.reason !== "limit" || held.handoff === undefined
                ? undefined
                : handoffFor(held, { agent: input.agent, harness: input.harness, ...opt("account", input.account), ...opt("model", input.model) });
        default:
            return undefined;
    }
};

/**
 * Supersedes every pending resume of the turn's conversation, as the turn begins: the hold it answers with is what the
 * turn goes on from (a fresh session gets what the dead turn's ledgers measured). Nothing for a turn with no conversation.
 */
export const replaceHeld = (services: Pick<Services, "conversations">, input: RoutedTurn): Replaced => {
    const held: HeldTurn | undefined =
        input.conversationId === undefined ? undefined : services.conversations.send(input.conversationId, { kind: "resume-superseded" }).reply;
    return { held, way: handoffWayOf(input, held) };
};

/**
 * The way on a turn keeps from the held turn it took the place of, for the hold its own refusal leaves where that refusal
 * ran nothing: such a hold re-runs in a fresh session whatever was picked (turn-resume.ts wallNote), so carrying or
 * trimming a session is gone, and the one way it can keep is a summary, where this turn was going on by one. Without
 * it the pick died with the refusal: a summary-picked "Continue" refused at the reset re-ran with the record alone.
 */
export const keptHandoffOf = ({ held, way }: Replaced): HandoffOffer | undefined => {
    const offer = held?.handoff;
    if (way !== "summary" || offer?.summary === undefined) {
        return undefined;
    }
    return { suggested: "summary", basis: offer.basis, summary: offer.summary, ...opt("chosen", offer.chosen === "summary" ? offer.chosen : undefined) };
};

/** The turn without the session it would resume: a summary opens a fresh one, seeded from the record. */
export const withoutSession = (turn: RoutedTurn): RoutedTurn => {
    const { sessionId: _session, resumeAt: _cut, ...rest } = turn;
    return rest;
};

/**
 * A held turn a person could have trimmed or summarised, carried whole instead: said too, with what it re-reads, so the
 * transcript names every way a choice went and not only the cheaper ones. Only where the session was resumed: one the
 * runtime no longer held opened fresh, and that is no carrying.
 */
export const carriedHandoff = (way: HandoffMode | undefined, held: HeldTurn | undefined, resumed: string | undefined): HandedOff | undefined =>
    way !== "carry" || held?.handoff === undefined || resumed === undefined ? undefined : { mode: "carry", ...opt("tokens", held.contextTokens) };

/**
 * Whether this turn re-runs a held one with its session onto another account than the one it was held on: the carry an
 * unanswered death reads as that account refusing it (classify-failure.ts, dressDeath). Read off the hold it replaces
 * rather than the note, since a trimmed hand-off is sent with the same note whether or not the account changed.
 */
export const carriedOffOf = (input: RoutedTurn, held: HeldTurn | undefined): boolean =>
    held !== undefined && (input.resume === "carried" || input.resume === "trimmed") && held.input.account !== input.account;
