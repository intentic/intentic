import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type AgentPress, NO_PRESS } from "@intentic/sandbox-contract/schemas/agent-press";
import { failureCourseOf } from "@intentic/sandbox-contract/policy/failure-codes";
import { RETRY_LADDER_TRIES } from "@intentic/sandbox-contract/schemas/turn-break";
import type { TurnEnding } from "@intentic/sandbox-contract/events/transcript";
import type { HeldRecord } from "../../actor/conversation-state.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";

/* HOW A CONVERSATION'S LAST TURN ENDED, AS A PRESS MOVES IT ON: stopped, out of allowance, a provider outage, or flagged.
   One reading, over the card's own fields and the turn the conversation's actor holds, read in two places: the card,
   whose `press` every chat window's strip follows (agents-registry.ts summaryOf), and the record, whose `ending` a tab
   opened later offers (the transcript route). Each window used to build its own from the live error frame it happened to
   watch, so a card in Finished stood beside a composer still offering a limit's Continue (2026-11-01, true-pine-bgzz),
   and a reloaded window lost its strip or kept a stale one. */

/** The card's own fields an ending is read off: the projected status, never the stored ending, and the failure it reports. */
export type EndingFacts = Pick<AgentSummary, "status" | "failureCode" | "failureRepeats" | "limitResetsAt" | "next">;

// Whether the held turn ran, what each way of moving on costs, where a policy is sending it, whether only a press
// sends it again, and whether memory killed it: the frame says so where it dresses the kill (memory-death.ts), and the
// card's press, which every window's strip follows over the frame, has to say it too, or a window would ask the stop's
// question of a turn the stop's answer never moves. A restart memory caused writes no frame at all (memory-restart.ts),
// so for its cut turns the press is the only place it is said.
const heldEnding = (held: HeldRecord): NonNullable<TurnEnding["held"]> => ({
    ran: held.ran,
    ...opt("contextTokens", held.contextTokens),
    ...opt("handoffTokens", held.handoffTokens),
    ...opt("moving", held.move?.account),
    ...opt("handoff", held.handoff),
    ...opt("pressOnly", held.pressOnly === true ? true : undefined),
    ...opt("memoryKill", held.memoryKill === undefined ? undefined : true),
});
// The live hold, never a summary flag: a restart clears the hold, so only it backs a re-run rather than a message.
// A stopped hold also says how far its automatic re-runs got, once any has gone; one held for a press alone climbs no
// ladder, whatever the conversation's count says (held-turn.ts pressOnly).
const heldOn = (held: HeldRecord | undefined): Pick<TurnEnding, "held" | "retries"> => {
    if (held === undefined) {
        return {};
    }
    const climbed = held.reason === "stopped" && held.pressOnly !== true && held.tries > 0;
    return { held: heldEnding(held), ...opt("retries", climbed ? { made: held.tries, max: RETRY_LADDER_TRIES } : undefined) };
};
// The card's re-run, as the ending states it (`scheduled`, and `nextAt` in epoch s only while it is still ahead, since a
// re-run already due goes on the next pass, which is "now" to a reader): the card's own `next`, never a reading of its own.
const rerunOf = (card: EndingFacts, now: number): Pick<TurnEnding, "scheduled" | "nextAt"> => {
    const next = card.next?.kind === "rerun" ? card.next : undefined;
    return next === undefined ? {} : { scheduled: true, ...opt("nextAt", next.at > now ? Math.ceil(next.at / 1000) : undefined) };
};

const failureEnding = (card: EndingFacts, held: HeldRecord | undefined, now: number): TurnEnding | undefined => {
    if (card.failureCode === "rate_limit") {
        return { reason: "limit", ...opt("resetsAt", card.limitResetsAt), ...heldOn(held), ...rerunOf(card, now) };
    }
    if (card.failureCode === "provider-outage") {
        return { reason: "outage" };
    }
    // Held for the person to route, the one coded failure a press answers: the same model again, or another.
    if (card.failureCode === "safeguard-flagged") {
        return { reason: "flagged", ...heldOn(held) };
    }
    // Stopped work with nothing to repair (a death nothing coded, a turn at its own ceiling or ended incomplete: the
    // `carry` course, failure-codes.ts), so the press just carries on. Any other code names something to repair first,
    // so no offer beats a press that would only re-fail. Nor does one on a failure that has already come back the same
    // with nothing run (failureRepeats): the chat offers the ways out instead (2026-11-05, twenty presses into one wall).
    return failureCourseOf(card.failureCode) === "carry" && card.failureRepeats === undefined ? { reason: "stopped", ...heldOn(held) } : undefined;
};

/**
 * How the last turn ended, as a press moves it on; undefined when nothing is there to continue. Off the projected status
 * (a Stop or a killed daemon reads `stopped`/`interrupted`; a resumed, landed or overtaken turn reports no failure), with
 * the reasons stop and kill don't cover (a spent allowance, an outage); a failure to repair first offers nothing.
 */
export const turnEndingOf = (card: EndingFacts, held: HeldRecord | undefined, now: number = Date.now()): TurnEnding | undefined => {
    if (card.status === "stopped" || card.status === "interrupted") {
        return { reason: "stopped" };
    }
    return card.status === "error" ? failureEnding(card, held, now) : undefined;
};

/** The card's press (AgentSummary.press): carry on from that ending, or nothing, said as such. */
export const pressOf = (card: EndingFacts, held: HeldRecord | undefined, now: number = Date.now()): AgentPress => {
    const ending = turnEndingOf(card, held, now);
    return ending === undefined ? NO_PRESS : { kind: "continue", ending };
};

/** The record's `ending` (the transcript route): the card's own press, so the two cannot say different things. */
export const endingOf = (deps: Pick<Services, "agents">, id: string): TurnEnding | undefined => {
    const press = deps.agents.get(id)?.press;
    return press?.kind === "continue" ? press.ending : undefined;
};
