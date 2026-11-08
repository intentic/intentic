import { type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelRef } from "@intentic/sandbox-contract/models/plan-pools";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../../composition.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { reopenedBy, sendableAt } from "../../../../conversations/actor/limit-booking.js";
import { allowanceWall, fleetCapacityOf } from "../../../../usage/serviceability/serviceability.js";
import { knownReopensAt } from "../../../models/limit-reset.js";
import { childRerunHorizonMs } from "../../../subagents/child-records.js";
import { childRerunAt } from "../../frames/classify-failure.js";
import { breakPolicyFor } from "../break-policy.js";

/* A STRANDED CARD'S LANE FOLLOWS WHAT THIS PASS WILL DO, BECAUSE IT IS READ OFF THE SAME FACTS (conversation-next.ts).
   What this keeps true is the facts themselves: a hold refused with no instant is timed once the records know one, a
   timed one is brought forward once its model can be served before that instant, and a "resuming" whose answer no
   longer resumes anything is withdrawn. The booking the card states is never written here:
   it used to be, every beat, onto the stored ending, and was wrong between beats (2026-10-19, 10-20). */

// How often a spent allowance's hold asks the records again, at most: one refused with no instant for when its pool
// reopens, a timed one whether its model can be served sooner. Since 2026-10-20 a new usage reading clears the pacing and
// wakes the pass (resume-nudges.ts, TurnResumeScheduler.retime), and since 2026-11-08 so does an account coming back to
// ready, each for the holds on its own provider alone; this minute is only the pace between those.
const RETIME_EVERY_MS = 60_000;

/** When each hold last asked, keyed by its provider and conversation (paceKey), so one provider's news clears its own. */
export type RetimePaces = Map<string, number>;

const paceKey = (provider: string, conversationId: string): string => `${provider}\u0000${conversationId}`;

/** Lets every hold on `provider` (every hold, where none is named) ask again at the next pass rather than at its minute. */
export const clearPaces = (paces: RetimePaces, provider?: string): void => {
    for (const key of paces.keys()) {
        if (provider === undefined || key.startsWith(`${provider}\u0000`)) {
            paces.delete(key);
        }
    }
};

// Whether a hold may ask now, stamping it if so: once a minute per hold, unless its provider's news cleared the stamp.
const mayAsk = (paces: RetimePaces, provider: string, conversationId: string, now: number): boolean => {
    const key = paceKey(provider, conversationId);
    const last = paces.get(key);
    if (last !== undefined && now - last < RETIME_EVERY_MS) {
        return false;
    }
    paces.set(key, now);
    return true;
};

/**
 * Times a spent allowance's hold that was refused with no instant, once the sandbox's records say when its pool reopens
 * (limit-reset.ts knownReopensAt): a reading taken since, or a sibling on the same model told when. Its "Send again"
 * then has an appointment to keep. Not a hold the refusal left untimed on purpose (a child's reset past its horizon,
 * stated on the ending and kept off the hold), nor a reset past the child's horizon now. `asked` paces the reads, one a
 * minute per conversation.
 */
const retimeLimitHold = async (services: Services, conversationId: string, held: HeldRecord, now: number, asked: RetimePaces): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    const untimed = held.reopensAt === undefined && held.move === undefined && entry?.ending.kind === "limited" && entry.ending.resetsAt === undefined;
    const provider = withRuntimeDefaults(held.input).agent;
    if (!untimed || !mayAsk(asked, provider, conversationId, now)) {
        return;
    }
    const account = held.onto?.account ?? held.input.account ?? entry.profile.account;
    const reopensAt = await knownReopensAt({ services, provider, model: held.input.model, account, now });
    if (reopensAt === undefined || reopensAt * 1000 <= now) {
        return;
    }
    const horizon = childRerunHorizonMs(services.conversations, conversationId, await services.sandboxSettings.get());
    if (horizon !== undefined && reopensAt * 1000 - now > horizon) {
        return;
    }
    const booked = horizon === undefined ? reopensAt : childRerunAt(reopensAt, conversationId);
    if (services.conversations.send(conversationId, { kind: "held-retimed", reopensAt: booked }, now).reply) {
        services.logger.info(
            { conversationId, reopensAt: new Date(reopensAt * 1000).toISOString() },
            "resume pass: a held turn refused with no reopen is timed to the one the records now know",
        );
    }
};

/* A TIMED HOLD GOES ONCE ITS MODEL CAN BE SERVED, NOT ONLY AT THE INSTANT IT WAS REFUSED WITH (2026-11-08). That instant
   is frozen at the refusal, and nothing brought it forward: a conversation refused on Google's Gemini pool waited for a
   reopen six days out while the picker already showed its model servable, on an account connected since. Each pass now
   asks, paced as the untimed hold is, whether the provider's accounts together can serve the hold's model
   (plan-pools.ts fleetCapacity, the rule the picker reads); where they can, the hold is re-timed to now. Never a hold
   with a booked move (the owner's answer to where it goes, which the pass performs as booked) or one a person pointed at
   an account (it keeps that account's reopen), and never while every account is spent. Nor while the account the hold
   would go on, where its turn or conversation names one, is still walled: the pass sends it there and would only hold
   it behind that wall again (limit-due.ts). A child's is spread as its refused siblings' are (childRerunAt), so a
   fan-out refused together does not go again in one second. */

// Whether the provider's accounts can serve the model together now, and the account the hold would go on too, where one
// is named, by the wall the pass reads before it sends. A verdict that cannot be read keeps the hold's instant.
const servableNow = async (
    services: Services,
    on: { readonly provider: AgentProvider; readonly account: string | undefined; readonly model: ModelRef | undefined },
    now: number,
): Promise<boolean> => {
    try {
        if ((await fleetCapacityOf(services, on.provider, on.model, now)).kind !== "serving") {
            return false;
        }
        return on.account === undefined || (await allowanceWall(services, on.provider, on.account, on.model, now)) === undefined;
    } catch (error) {
        services.logger.warn(
            { err: error, provider: on.provider },
            "resume pass: the accounts could not be judged for a held turn's model, it keeps its reopen",
        );
        return false;
    }
};

const wakeTimedLimitHold = async (services: Services, conversationId: string, held: HeldRecord, now: number, asked: RetimePaces): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    const refusedUntil = held.reopensAt;
    const provider = withRuntimeDefaults(held.input).agent;
    if (entry === undefined || refusedUntil === undefined || sendableAt(refusedUntil) <= now || held.move !== undefined || held.onto !== undefined) {
        return;
    }
    if (!mayAsk(asked, provider, conversationId, now)) {
        return;
    }
    const model = held.input.model === undefined || held.input.model === "" ? undefined : { id: held.input.model };
    if (!(await servableNow(services, { provider, account: held.input.account ?? entry.profile.account, model }, now))) {
        return;
    }
    const spawned = childRerunHorizonMs(services.conversations, conversationId, await services.sandboxSettings.get()) !== undefined;
    const reopensAt = spawned ? childRerunAt(reopenedBy(now), conversationId) : reopenedBy(now);
    if (services.conversations.send(conversationId, { kind: "held-retimed", reopensAt, early: true }, now).reply) {
        services.logger.info(
            { conversationId, provider, model: held.input.model, refusedUntil: new Date(refusedUntil * 1000).toISOString() },
            "resume pass: a held turn's model can be served again before the reopen it was refused with, so it is re-timed to now",
        );
    }
};

// What a "resuming" card withdrawn because its answer no longer resumes it says: why it stopped promising, and the press.
const NO_LONGER_ARMED = "This turn is no longer picked up by itself: the answer to how it ended is now to wait. Continue carries it on.";
// The same for a hold nothing but a press ever lets go, whatever the answer.
const PRESS_ONLY = "This turn stopped at its own limit and is not picked up by itself. Continue carries it on.";
const MEMORY_PRESS_ONLY = "This turn was killed for memory and is likely the cause, so it is not picked up by itself. Continue carries it on.";

// A stopped or outage hold armed when its turn ended reads "resuming", in Active. Once its answer is wait, nothing will
// resume it, so the promise is withdrawn and the hold left for a press: the card falls to Attention with Continue. Left
// alone it stood in Active for good, since the pass returns before its rung on an unarmed answer. A hold for a press
// alone (held-turn.ts pressOnly) is resumed by nothing whatever the answer, so it never reads "resuming" either.
const withdrawUnarmedResume = async (services: Services, conversationId: string, held: HeldRecord, now: number): Promise<void> => {
    if ((held.reason !== "stopped" && held.reason !== "outage") || services.conversations.state(conversationId)?.turn.resuming !== true) {
        return;
    }
    const pressOnly = held.pressOnly === true;
    // A memory kill is answered by the memory release's question, not the stop ladder's (room-holds.ts).
    const ending = held.memoryKill === undefined ? held.reason : "memoryKill";
    if (!pressOnly && breakArmed(await breakPolicyFor(services, conversationId, ending))) {
        return;
    }
    const said = pressOnly ? (held.memoryKill === undefined ? PRESS_ONLY : MEMORY_PRESS_ONLY) : NO_LONGER_ARMED;
    if (await services.conversations.send(conversationId, { kind: "resume-abandoned", reason: said }, now).settled) {
        services.logger.info({ conversationId, reason: held.reason, pressOnly }, "resume pass: a resuming turn's answer is now to wait, so it waits for a press");
    }
};

// Holds a stranded conversation's card to what this pass will do with what it holds now (after its rung had its go).
export const keepStandingTrue = async (services: Services, conversationId: string, now: number, asked: RetimePaces): Promise<void> => {
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.fired) {
        return;
    }
    if (held.reason !== "limit") {
        await withdrawUnarmedResume(services, conversationId, held, now);
        return;
    }
    await (held.reopensAt === undefined
        ? retimeLimitHold(services, conversationId, held, now, asked)
        : wakeTimedLimitHold(services, conversationId, held, now, asked));
};
