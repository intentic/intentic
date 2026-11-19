import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../../composition.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { breakPolicyFor } from "../break-policy.js";

/* A STRANDED CARD'S LANE FOLLOWS WHAT THIS PASS WILL DO, BECAUSE IT IS READ OFF THE SAME FACTS (conversation-next.ts).
   What this keeps true is the one fact a pass's rung does not: a "resuming" whose answer no longer resumes anything is
   withdrawn. A spent allowance's hold needs nothing kept true here any more: when and where it goes is read against the
   records at every pass (held-verdict.ts), where until 2026-11-19 this module re-timed it once a minute, an untimed hold
   to the reopen the records learned and a timed one to now once its model could be served. */

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
export const keepStandingTrue = async (services: Services, conversationId: string, now: number): Promise<void> => {
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.fired) {
        return;
    }
    await withdrawUnarmedResume(services, conversationId, held, now);
};
