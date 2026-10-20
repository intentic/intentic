import type { Services } from "../../../../composition.js";
import type { ConversationEvent } from "../../../../conversations/actor/conversation-decide.js";
import type { ConversationState } from "../../../../conversations/actor/conversation-state.js";
import { onAccountReopened } from "../../../../usage/serviceability/state-log.js";
import type { TurnResumeScheduler } from "../turn-resume.js";

/* WHAT WAKES THE RESUME PASS. It used to walk every held turn every five seconds, and nothing called it sooner, so
   whatever an event had just made due waited out the beat: an overflow's own remedy, a re-minted sign-in, a booked send,
   a spent allowance whose reopen a reading had just shown (2026-10-20). Each event below may have made a hold due, or
   changed the answer it is judged by, and nudges the pass; the instants it already knows arm its own timer
   (createTurnResumeScheduler), and its backstop catches anything an event missed. */

// Whether an event applied to a conversation may have given the pass something to do there: a hold recorded or changed
// (a new record; one the pass fired or dropped is not, so its own acts do not wake it again), words queued or re-timed
// while the queue holds any, or a land let go, which a send booked after that conversation's work waits for.
export const wakesResumePass = (event: ConversationEvent, before: ConversationState, after: ConversationState): boolean => {
    const held = after.resume.held;
    if (held !== before.resume.held && held !== undefined && !held.fired) {
        return true;
    }
    if (after.queue !== before.queue && after.queue.items.length > 0) {
        return true;
    }
    return event.kind === "land-released";
};

/** Wires every event that may make a held turn due to a nudge of the pass; answers the unsubscribe of them all. */
export const nudgeResumesOn = (
    services: Pick<Services, "conversations" | "events" | "sandboxSettings" | "headroom">,
    scheduler: Pick<TurnResumeScheduler, "nudge" | "retime">,
): (() => void) => {
    const nudge = (): void => scheduler.nudge();
    const unsubscribes = [
        services.conversations.observe((_id, event, before, after) => {
            if (wakesResumePass(event, before, after)) {
                nudge();
            }
        }),
        // A turn ending unwinds the one a give-up waited on, frees memory a room hold waits for, and may land work.
        services.events.subscribe("run.settled", nudge),
        services.events.subscribe("workspace", nudge),
        // A conversation's or the sandbox's answer to a wall decides whether its hold fires at all.
        services.sandboxSettings.onSet(nudge),
        // An account back to ready is a reopen the holds on it wait for.
        onAccountReopened(nudge),
        // A new usage reading may name the reopen a hold refused with no instant was waiting to learn (held-standing.ts).
        services.headroom.onChange(() => scheduler.retime()),
    ];
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    };
};
