import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type AgentStanding, limitClosed, limited } from "../../agent-status/agentStatus-standing";
import { type SendBlock, sendBlockOf } from "../../providers/sendAvailability";
import { type PickUp, pickUpCooling, pickUpOf } from "./pickUp";

/* ONE RULE FOR A PERSON'S PRESS ON A TURN THAT STOPPED SHORT, AGAINST THE ACCOUNT IT WOULD RUN ON. The same spent
   allowance with no known reset (Cursor, Grok and Devin publish none; a refusal can name no instant) used to get three
   answers: the strip's Continue greyed with an "awaiting reset" hover for a reset nobody knew, the board card's Send again
   enabled, and typed words sent anyway. The strip, the composer and the card now ask this one function.

   The rule. A press always goes, unless this window is resting after a refusal where nothing ran (pickUp.ts
   cooledPickUp: pressing again at once is refused the same way), the sandbox does not answer, or a press is already
   under way. What a reading in the way changes is the press's weight, never whether it goes: a reopen known to be ahead
   makes trying now a quiet press beside a solid one at the reopen; a reading with no reopen (spent with none published,
   an account blocked) makes it a quiet Try now that names the reading, since readings lag the provider and a refused try
   costs nothing, the rule typed words already follow (composerIntent.ts accountCautionOf, 2026-10-26). Two walls keep
   their own presses: an access wall's re-test and connect (accessWall.ts), and a flagged turn's retry or other model.
   The bare Enter on an empty box is not this: it keeps composerIntent.ts's stricter offer (continueOffered). */

/** What the press is weighed against: the pick-up the strip shows, and the account the press would run on. */
export interface PressFacts {
    readonly pickUp: PickUp;
    /** The verdict on the account the press would run on (the composer's servingState); undefined where none is read. */
    readonly state: AccountState | undefined;
    /** When that account reopens (ms), while it reads spent with that still ahead (runServing.ts spentUntilOf). */
    readonly spentUntil: number | undefined;
    /** No account of the provider can serve the conversation (accessWall.ts): its own controls stand for the press. */
    readonly accessWall: boolean;
    readonly reachable: boolean;
    /** A press is already under way (TurnClient.continuing). */
    readonly continuing: boolean;
    readonly now: number;
}

/**
 * The strip's press: `continue` one solid Continue; `tryThenAt` a quiet Try now, the solid press going at the reopen
 * (`at`); `try` a quiet Try now past a reading in the way (`reading`), or past an unheld allowance's own reset still ahead
 * (`at`); `flagged` and `wall` the two walls' own presses.
 */
export type PressKind = `continue` | `tryThenAt` | `try` | `flagged` | `wall`;

/** Why the press does not go now; absent while it does. */
export type PressRest = `cooling` | `unreachable` | `continuing`;

export interface PressWay {
    readonly kind: PressKind;
    readonly enabled: boolean;
    readonly rest?: PressRest;
    readonly reading?: SendBlock;
    readonly at?: number;
}

/** Why the press waits, if it does: the sandbox not answering, a press under way, or this window's rest after a refusal. */
const pressRest = (facts: Pick<PressFacts, "pickUp" | "reachable" | "continuing" | "now">): PressRest | undefined => {
    if (!facts.reachable) {
        return `unreachable`;
    }
    if (facts.continuing) {
        return `continuing`;
    }
    return pickUpCooling(facts.pickUp, facts.now) ? `cooling` : undefined;
};

/** Whether the strip's press goes now (pressRest), as the composer reads it for the strip and for its own Continue. */
export const pressGoes = (pickUp: PickUp | undefined, reachable: boolean, continuing: boolean, now: number): boolean =>
    pickUp !== undefined && pressRest({ pickUp, reachable, continuing, now }) === undefined;

// An unheld allowance's own reset, still ahead, where nothing read says the account has room: the press would carry the
// session on into the same wall, which is a try, and is said as one. A held turn re-runs whatever the reset says.
const ownResetAhead = (facts: PressFacts): number | undefined => {
    const { pickUp, state, now } = facts;
    const ahead = pickUp.reason === `limit` && pickUp.held === undefined && pickUp.readyAt !== undefined && pickUp.readyAt > now;
    return ahead && state?.kind !== `ready` ? pickUp.readyAt : undefined;
};

const weighedKind = (facts: PressFacts): Omit<PressWay, "enabled" | "rest"> => {
    if (facts.accessWall) {
        return { kind: `wall` };
    }
    if (facts.pickUp.reason === `flagged`) {
        return { kind: `flagged` };
    }
    if (facts.spentUntil !== undefined) {
        return { kind: `tryThenAt`, at: facts.spentUntil };
    }
    const reading = sendBlockOf(facts.state, facts.now);
    if (reading !== undefined) {
        return { kind: `try`, reading };
    }
    const reset = ownResetAhead(facts);
    return reset === undefined ? { kind: `continue` } : { kind: `try`, at: reset };
};

/** The strip's press for these facts: which press it is, and whether it goes now. */
export const pressWayOf = (facts: PressFacts): PressWay => {
    const way = { ...weighedKind(facts), enabled: true };
    const rest = pressRest(facts);
    return rest === undefined ? way : { ...way, enabled: false, rest };
};

/** Whether the press goes at the reopen rather than now: the solid press of a `tryThenAt`. */
export const goesAtReopen = (way: PressWay): boolean => way.kind === `tryThenAt`;

// A stranded card's turn as the strip would show it: the card's press where the daemon says it, else its limit fields.
const cardPickUp = (agent: AgentStanding): PickUp => {
    if (agent.press?.kind === `continue`) {
        return pickUpOf(agent.press.ending);
    }
    const readyAt = agent.limitResetsAt === undefined ? {} : { readyAt: agent.limitResetsAt * 1_000 };
    return agent.limitHeld === true ? { reason: `limit`, ...readyAt, held: { ran: true } } : { reason: `limit`, ...readyAt };
};

/**
 * The board card's press for a turn a spent allowance stranded (cardRequests.ts): the same rule, weighed against the one
 * reading the card has, the daemon's reopen for the account the hold goes on (`limitResetsAt`, the hold's own). Goes at
 * the reopen where that is ahead (Send at reset), else now (Send again), as the strip's solid press does for the same
 * reopen. Undefined for a card no spent allowance stranded.
 */
export const cardPressWay = (agent: AgentStanding, now: number): PressWay | undefined => {
    if (!limited(agent)) {
        return undefined;
    }
    const spentUntil = limitClosed(agent, now) && agent.limitResetsAt !== undefined ? agent.limitResetsAt * 1_000 : undefined;
    return pressWayOf({ pickUp: cardPickUp(agent), state: undefined, spentUntil, accessWall: false, reachable: true, continuing: false, now });
};
