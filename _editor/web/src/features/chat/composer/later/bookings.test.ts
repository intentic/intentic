import type { ConversationQueue, QueuedMessage } from "@intentic/sandbox-contract";
import { bookedGroups, bookingOfMessage, holdOfQueue, perMessage, queueFromMessages, unbookedOf } from "./bookings";

// Which waiting message goes when, from both kinds of sandbox: one that books each message on its own (2026-10 on), and
// one that books the whole queue at once, whose queue-level booking is every message's.

const message = (id: string, booking: Pick<QueuedMessage, "until" | "after"> = {}): QueuedMessage => ({
    id,
    text: `say ${id}`,
    voice: `person`,
    queuedAt: 1_000,
    revision: 1,
    ...booking,
});

describe(`a queue that books each message on its own`, () => {
    const queue: ConversationQueue = {
        items: [message(`a`, { until: 5_000 }), message(`b`, { until: 5_000 }), message(`held`), message(`c`, { after: `brave-otter` })],
        revision: 4,
        paused: `stopped`,
    };

    it(`reads each message's own booking, and a Stop as the hold on the rest`, () => {
        expect(perMessage(queue)).toBe(true);
        expect(bookingOfMessage(queue, queue.items[0]!)).toEqual({ kind: `at`, at: 5_000 });
        expect(bookingOfMessage(queue, queue.items[2]!)).toBeUndefined();
        expect(bookingOfMessage(queue, queue.items[3]!)).toEqual({ kind: `after`, conversationId: `brave-otter` });
        expect(holdOfQueue(queue)).toBe(`stopped`);
        expect(unbookedOf(queue).map((item) => item.id)).toEqual([`held`]);
    });

    it(`gathers neighbours booked alike into one group, and nothing across a message with no booking`, () => {
        expect(bookedGroups(queue).map(({ booking, ids }) => ({ booking, ids }))).toEqual([
            { booking: { kind: `at`, at: 5_000 }, ids: [`a`, `b`] },
            { booking: { kind: `after`, conversationId: `brave-otter` }, ids: [`c`] },
        ]);
        const split = { ...queue, items: [message(`a`, { until: 5_000 }), message(`held`), message(`b`, { until: 5_000 })] };
        expect(bookedGroups(split).map(({ ids }) => ids)).toEqual([[`a`], [`b`]]);
    });

    it(`reads its queue-level scheduled as the soonest booking, which holds nothing`, () => {
        const shadow: ConversationQueue = { items: [message(`a`, { until: 5_000 }), message(`now`)], revision: 2, paused: `scheduled`, until: 5_000 };
        expect(holdOfQueue(shadow)).toBeUndefined();
        expect(unbookedOf(shadow).map((item) => item.id)).toEqual([`now`]);
    });

    it(`derives the queue's own fields as the sandbox does: the hold while it has a message to hold, else the soonest booking`, () => {
        const items = [message(`a`, { until: 9_000 }), message(`b`, { until: 5_000 }), message(`c`, { after: `brave-otter` })];
        expect(queueFromMessages(items, 3, undefined)).toEqual({ items, revision: 3, paused: `scheduled`, until: 5_000 });
        expect(queueFromMessages([message(`c`, { after: `brave-otter` })], 1, `stopped`)).toEqual({
            items: [message(`c`, { after: `brave-otter` })],
            revision: 1,
            paused: `scheduled`,
            after: `brave-otter`,
        });
        expect(queueFromMessages([...items, message(`held`)], 4, `stopped`)).toEqual({ items: [...items, message(`held`)], revision: 4, paused: `stopped` });
        expect(queueFromMessages([message(`now`)], 1, undefined)).toEqual({ items: [message(`now`)], revision: 1 });
    });
});

describe(`a queue booked as a whole, by a sandbox older than per-message bookings`, () => {
    const queue: ConversationQueue = { items: [message(`a`), message(`b`)], revision: 2, paused: `scheduled`, until: 5_000 };

    it(`gives every message the queue's booking, in one group, held as scheduled`, () => {
        expect(perMessage(queue)).toBe(false);
        expect(bookingOfMessage(queue, queue.items[1]!)).toEqual({ kind: `at`, at: 5_000 });
        expect(holdOfQueue(queue)).toBe(`scheduled`);
        expect(unbookedOf(queue)).toEqual([]);
        expect(bookedGroups(queue).map(({ booking, ids }) => ({ booking, ids }))).toEqual([{ booking: { kind: `at`, at: 5_000 }, ids: [`a`, `b`] }]);
    });

    it(`books nothing on a queue a Stop holds, or that nothing holds`, () => {
        expect(bookedGroups({ ...queue, paused: `stopped`, until: undefined })).toEqual([]);
        expect(holdOfQueue({ ...queue, paused: `stopped`, until: undefined })).toBe(`stopped`);
        expect(unbookedOf({ items: queue.items }).map((item) => item.id)).toEqual([`a`, `b`]);
    });
});
