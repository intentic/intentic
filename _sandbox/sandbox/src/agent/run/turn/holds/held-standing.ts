import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../../composition.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { opt } from "../../../../opt.js";
import { knownReopensAt } from "../../../models/limit-reset.js";
import { childRerunHorizonMs } from "../../../subagents/child-records.js";
import { childRerunAt } from "../../frames/classify-failure.js";
import { breakPolicyFor } from "../break-policy.js";
import { limitDue } from "./limit-due.js";

/* A STRANDED CARD'S LANE FOLLOWS WHAT THIS PASS WILL DO. The card files a held turn in Active only while it says
   something will send it (agent-lanes.ts laneOf), and what it says is stored on the entry, so every path that changes a
   hold or its answer used to have to remember to re-book it, and several did not: a sandbox-wide answer changed in
   Settings, an account picked mid-hold, a child held past its horizon. Each beat now holds the stored booking to the rule
   this pass fires by (limit-booking.ts), times a hold refused with no instant once the records know one, and withdraws a
   "resuming" whose answer no longer resumes anything. A card can be wrong for one beat, not for good (2026-10-19). */

// How often a hold refused with no instant asks the records again for when its pool reopens, at most. Since 2026-10-20
// a new usage reading clears the pacing and wakes the pass (resume-nudges.ts, TurnResumeScheduler.retime), so a reading
// that names the reopen times the hold at once; this minute is only the pace between readings.
const RETIME_EVERY_MS = 60_000;

/**
 * Times a spent allowance's hold that was refused with no instant, once the sandbox's records say when its pool reopens
 * (limit-reset.ts knownReopensAt): a reading taken since, or a sibling on the same model told when. Its "Send again"
 * then has an appointment to keep. Not a hold the refusal left untimed on purpose (a child's reset past its horizon,
 * stated on the ending and kept off the hold), nor a reset past the child's horizon now. Answers the reopen it was timed
 * to (epoch s), or undefined. `asked` paces the reads, one a minute per conversation.
 */
const retimeLimitHold = async (services: Services, conversationId: string, held: HeldRecord, now: number, asked: Map<string, number>): Promise<number | undefined> => {
    const entry = services.agents.entry(conversationId);
    const untimed = held.reopensAt === undefined && held.move === undefined && entry?.ending.kind === "limited" && entry.ending.resetsAt === undefined;
    const last = asked.get(conversationId);
    if (!untimed || (last !== undefined && now - last < RETIME_EVERY_MS)) {
        return undefined;
    }
    asked.set(conversationId, now);
    const account = held.onto?.account ?? held.input.account ?? entry.profile.account;
    const reopensAt = await knownReopensAt({ services, provider: withRuntimeDefaults(held.input).agent, model: held.input.model, account, now });
    if (reopensAt === undefined || reopensAt * 1000 <= now) {
        return undefined;
    }
    const horizon = childRerunHorizonMs(services.conversations, conversationId, await services.sandboxSettings.get());
    if (horizon !== undefined && reopensAt * 1000 - now > horizon) {
        return undefined;
    }
    const booked = horizon === undefined ? reopensAt : childRerunAt(reopensAt, conversationId);
    if (!services.conversations.send(conversationId, { kind: "held-retimed", reopensAt: booked }, now).reply) {
        return undefined;
    }
    services.logger.info(
        { conversationId, reopensAt: new Date(reopensAt * 1000).toISOString() },
        "resume pass: a held turn refused with no reopen is timed to the one the records now know",
    );
    return reopensAt;
};

// A spent allowance's hold: timed where the records now can, then its stored booking held to the reading this pass fires
// by (limit-due.ts), the wall in front of where it goes included, so the card's instant is the one the pass will keep.
const keepLimitBooking = async (services: Services, conversationId: string, held: HeldRecord, now: number, asked: Map<string, number>): Promise<void> => {
    const timed = await retimeLimitHold(services, conversationId, held, now, asked);
    const current = services.conversations.state(conversationId)?.resume.held ?? held;
    const booking = (await limitDue(services, conversationId, current, now))?.booking;
    if (await services.agents.keepLimitBooking(conversationId, booking, timed)) {
        services.logger.info(
            { conversationId, booked: booking === undefined ? "press only" : new Date(booking.at).toISOString(), ...opt("moving", booking?.moving) },
            "resume pass: a held turn's card now says what the pass will do with it",
        );
    }
};

// What a "resuming" card withdrawn because its answer no longer resumes it says: why it stopped promising, and the press.
const NO_LONGER_ARMED = "This turn is no longer picked up by itself: the answer to how it ended is now to wait. Continue carries it on.";

// A stopped or outage hold armed when its turn ended reads "resuming", in Active. Once its answer is wait, nothing will
// resume it, so the promise is withdrawn and the hold left for a press: the card falls to Attention with Continue. Left
// alone it stood in Active for good, since the pass returns before its rung on an unarmed answer.
const withdrawUnarmedResume = async (services: Services, conversationId: string, held: HeldRecord, now: number): Promise<void> => {
    if ((held.reason !== "stopped" && held.reason !== "outage") || services.conversations.state(conversationId)?.turn.resuming !== true) {
        return;
    }
    if (breakArmed(await breakPolicyFor(services, conversationId, held.reason))) {
        return;
    }
    if (await services.conversations.send(conversationId, { kind: "resume-abandoned", reason: NO_LONGER_ARMED }, now).settled) {
        services.logger.info({ conversationId, reason: held.reason }, "resume pass: a resuming turn's answer is now to wait, so it waits for a press");
    }
};

// Holds a stranded conversation's card to what this pass will do with what it holds now (after its rung had its go).
export const keepStandingTrue = async (services: Services, conversationId: string, now: number, asked: Map<string, number>): Promise<void> => {
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.fired) {
        return;
    }
    await (held.reason === "limit" ? keepLimitBooking(services, conversationId, held, now, asked) : withdrawUnarmedResume(services, conversationId, held, now));
};
