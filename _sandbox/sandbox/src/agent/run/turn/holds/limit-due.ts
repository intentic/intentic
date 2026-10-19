import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Services } from "../../../../composition.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { type LimitBooking, limitBooking } from "../../../../conversations/actor/limit-booking.js";
import { spentUntil } from "./allowance-gate.js";
import { breakPolicyFor } from "../break-policy.js";
import { opt } from "../../../../opt.js";

/* WHEN A SPENT ALLOWANCE'S HELD TURN ACTUALLY GOES, AND WHERE, READ ONCE A BEAT FOR BOTH THE PASS AND THE CARD. The
   booking is the hold's own rule (limit-booking.ts) on the conversation's answer to the limit, held behind the allowance
   wall in front of the account it would go on, as the records call it right now (allowance-gate.ts spentUntil, by the
   one verdict in serviceability.ts). The resume pass fires a hold only once this says it is due (turn-resume.ts
   runLimitHold), and the card states this same instant (held-standing.ts keepLimitBooking, limitNextAt), so what the
   card promises and what the pass does are one reading, not two. */

export interface LimitDue {
    readonly booking: LimitBooking;
    // Where it goes when it fires: the booked move's account, else the account a person picked mid-hold, else its own.
    readonly routing?: ResumeRouting;
    // The booking stored on the hold was due, and the wall in front of where it goes holds it back (ms): said once.
    readonly walledUntil?: number;
}

// Where a booked hold goes: a move's account while the answer is still to move, else a person's pick, else its own.
const limitRouting = (held: HeldRecord, booking: LimitBooking): ResumeRouting | undefined => {
    const { agent, harness } = withRuntimeDefaults(held.input);
    if (booking.moving !== undefined && held.move !== undefined) {
        return { agent, harness, account: held.move.account, carry: held.move.carry };
    }
    return held.onto === undefined ? undefined : { agent, harness, account: held.onto.account, ...opt("carry", held.onto.carry ? true : undefined) };
};

/** What an unfired limit hold does by itself now, or undefined where only a press sends it (limit-booking.ts). */
export const limitDue = async (services: Services, conversationId: string, held: HeldRecord, now: number): Promise<LimitDue | undefined> => {
    const policy = await breakPolicyFor(services, conversationId, "limit");
    const booked = limitBooking(held, policy);
    if (booked === undefined) {
        return undefined;
    }
    const routing = limitRouting(held, booked);
    const account = routing?.account ?? held.input.account;
    const wall = await spentUntil(services, account === undefined ? held.input : { ...held.input, account }, now);
    const booking = limitBooking(held, policy, wall) ?? booked;
    const walledUntil = booked.at <= now && booking.at > now ? booking.at : undefined;
    return { booking, ...opt("routing", routing), ...opt("walledUntil", walledUntil) };
};
