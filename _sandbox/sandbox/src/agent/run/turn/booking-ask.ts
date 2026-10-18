import type { Services } from "../../../composition.js";
import type { Booking } from "../../../conversations/actor/conversation-queue.js";
import { unwaitable, workLanded } from "../../../conversations/land/work-landed.js";
import type { Said, Unsaid } from "../../../seams/turn-starter.js";

// What a scheduled send asks to wait for, read into the booking the queue keeps: shared by a person's words booked for
// later (turn-admission.ts) and a Continue booked for later (continuation.ts), so the two can never wait differently.

// How far ahead a scheduled send may be booked. A time somebody chose is an appointment, and a month holds every one
// worth keeping (a spent allowance reopens within a week); past it a booking is a slip, a year typed for a day.
const LONGEST_BOOKING_MS = 31 * 24 * 60 * 60 * 1000;

// What a scheduled send asks to wait for, as its fields name it: an instant, or another conversation's work; and which
// conversation is asking.
export interface BookingAsk {
    readonly conversationId: string;
    readonly sendAt?: number | undefined;
    readonly sendAfter?: string | undefined;
}

/**
 * The booking a scheduled send waits by, undefined when there is nothing left to wait for (an instant already past, a
 * conversation whose work is all in the workspace already: it goes now, the ordinary way), or why it cannot wait (the
 * conversation it names cannot land anything). Clamped, not refused: the person asked for it to wait, and a month is the
 * longest wait there is. A turn running here, or a recovery going first, books it all the same: the person chose when it
 * goes, and a turn ending is not that moment.
 */
export const bookingOfAsk = (services: Services, ask: BookingAsk, now: number): Booking | undefined | Unsaid => {
    if (ask.sendAfter !== undefined) {
        const why = unwaitable(services, ask.sendAfter, ask.conversationId);
        if (why !== undefined) {
            return { invalid: why };
        }
        return workLanded(services, ask.sendAfter, now) ? undefined : { after: { conversationId: ask.sendAfter, since: now } };
    }
    return ask.sendAt === undefined || ask.sendAt <= now ? undefined : { until: Math.min(ask.sendAt, now + LONGEST_BOOKING_MS) };
};

// A person's words only: the sandbox's and an agent's never wait on a clock somebody set.
export const bookingFor = (services: Services, said: Said, now: number): Booking | undefined | Unsaid =>
    said.voice === "person" ? bookingOfAsk(services, said.turn, now) : undefined;

export const unbookable = (booking: Booking | Unsaid | undefined): booking is Unsaid => booking !== undefined && ("invalid" in booking || "why" in booking);
