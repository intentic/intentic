import type { Services } from "../../../composition.js";
import type { Booked } from "../../../conversations/actor/conversation-actors.js";
import { type Booking, bookingOfItem } from "../../../conversations/actor/conversation-queue.js";
import { versionCommitsSettled } from "../../../conversations/land/version-landed.js";
import { landingRepos, workLanded } from "../../../conversations/land/work-landed.js";
import { rebookedForReopen } from "./holds/allowance-gate.js";

// A person's scheduled sends let go when what each waits for comes: its instant, or another conversation's work landing.
// One step of the resume pass (turn-resume.ts, createTurnResumeScheduler), apart from it since nothing here touches a held
// turn: these are words in the queue, booked by their own bookings (conversation-queue.ts).

// Whether what a scheduled send waits for has come: its instant, or the conversation it waits on finished with all of its
// work in the workspace (work-landed.ts).
const bookingDue = (services: Services, booking: Booking, now: number): boolean =>
    booking.after === undefined ? booking.until <= now : workLanded(services, booking.after.conversationId, booking.after.since);

// Whether a message still waits by the same booking: a person may have sent it, taken it back or re-timed it while the
// release waited on a version commit, and their word is the newer one.
const sameBooking = (held: Booking | undefined, booked: Booking): boolean =>
    held !== undefined && held.until === booked.until && held.after?.conversationId === booked.after?.conversationId;

// Lets one conversation's due scheduled sends go, and only those: every other booking keeps its time. One that waited on
// another conversation's land first waits out that land's version commit (version-landed.ts), so the turn it starts reads
// that work committed under its own subject, rather than sweeping it into the "Your edits" commit an isolated turn makes
// of the main tree before it starts (versionMainTree). Each message's booking is read again after that wait, and only one
// still booked the same goes.
const letGo = async (services: Services, conversationId: string, due: readonly Booked[], now: number): Promise<void> => {
    const lands = new Set(due.flatMap(({ booking }) => (booking.after === undefined ? [] : [booking.after.conversationId])));
    if (lands.size > 0) {
        await versionCommitsSettled(services, [...new Set([...lands].flatMap((land) => landingRepos(services, land)))]);
    }
    const { items } = services.conversations.queued(conversationId);
    const still = due.filter(({ id, booking }) => {
        const item = items.find((waiting) => waiting.id === id);
        return item !== undefined && sameBooking(bookingOfItem(item), booking);
    });
    if (still.length === 0) {
        return;
    }
    const ids = still.map(({ id }) => id);
    // Their time came, but the account they go on is still spent: booked again for its reopen (allowance-gate.ts), as
    // the composer booked them for the reopen it read then, rather than burned on a refusal.
    if (await rebookedForReopen(services, conversationId, ids, now)) {
        return;
    }
    services.conversations.send(conversationId, { kind: "queue-released", ids }, now);
    services.logger.info(
        { conversationId, messages: still.length, after: [...lands] },
        lands.size === 0 ? "resume pass: a scheduled send's time came, it goes out" : "resume pass: the work a scheduled send waited for landed, it goes out",
    );
    await services.turns.drain(conversationId);
};

// A person's scheduled sends whose time has come (turn-admission.ts, bookingFor): their bookings are let go and they go
// out as the ordinary turn they would have been, together where they fall due together. Onto an account the records
// still call spent they are booked again for its reopen (letGo); should the provider refuse them all the same, that
// turn is refused like any other, and the conversation's limit answer takes it from there.
export const releaseBooked = async (services: Services, now: number): Promise<void> => {
    const due = new Map<string, Booked[]>();
    for (const booked of services.conversations.booked()) {
        if (bookingDue(services, booked.booking, now)) {
            due.set(booked.conversationId, [...(due.get(booked.conversationId) ?? []), booked]);
        }
    }
    for (const [conversationId, messages] of due) {
        try {
            await letGo(services, conversationId, messages, now);
        } catch (error) {
            services.logger.error({ err: error, conversationId }, "resume pass: a scheduled send could not be let go, the pass goes on to the next");
        }
    }
};
