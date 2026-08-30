import { beforeEach, describe, expect, it } from "vitest";
import { acquireStreamSlot, resetStreamBudget, setStreamCapacity, streamCapacity } from "./streamBudget";

beforeEach(() => {
    resetStreamBudget();
});

// A slot taken and immediately dropped on the floor: the shape most of these assertions need.
const take = async (signal?: AbortSignal): Promise<(() => void) | undefined> => acquireStreamSlot(signal);

describe(`streamCapacity`, () => {
    it(`only caps the transport that cannot multiplex`, () => {
        // h2 carries ~100 streams on one connection, so capping there would serialize for nothing.
        expect(streamCapacity(`local`)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(`tunnel`)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(undefined)).toBe(Number.POSITIVE_INFINITY);
        // Plain http loopback is HTTP/1.1 and always will be: no browser speaks cleartext h2.
        expect(streamCapacity(`local-insecure`)).toBe(4);
    });

    it(`leaves the browser room for ordinary requests`, () => {
        // The whole point: six connections exist, and the streams may not have all of them. Two spare slots are
        // what keeps a file read answerable while four agents stream.
        expect(streamCapacity(`local-insecure`)).toBeLessThan(6);
    });
});

describe(`acquireStreamSlot`, () => {
    it(`never queues on a transport that multiplexes`, async () => {
        setStreamCapacity(() => Number.POSITIVE_INFINITY);
        const slots = await Promise.all(Array.from({ length: 50 }, () => take()));
        expect(slots.every((release) => release !== undefined)).toBe(true);
    });

    it(`admits up to capacity and parks the rest`, async () => {
        setStreamCapacity(() => 2);
        expect(await take()).toEqual(expect.any(Function));
        expect(await take()).toEqual(expect.any(Function));

        let third = false;
        void take().then(() => (third = true));
        await Promise.resolve();
        expect(third).toBe(false);
    });

    it(`hands a freed slot to a waiter`, async () => {
        setStreamCapacity(() => 1);
        const first = await take();
        let second: (() => void) | undefined;
        const queued = take().then((release) => (second = release));

        first?.();
        await queued;
        expect(second).toEqual(expect.any(Function));
    });

    it(`serves the newest waiter first: the conversation the user just acted on`, async () => {
        setStreamCapacity(() => 1);
        const held = await take();
        const order: string[] = [];
        let newerRelease: (() => void) | undefined;
        const older = take().then((release) => order.push(`older`) && release);
        const newer = take().then((release) => {
            order.push(`newer`);
            newerRelease = release;
        });

        held?.();
        await newer;
        expect(order).toEqual([`newer`]);

        // Parked, not dropped: the background agent gets its turn as soon as the visible one's stream ends.
        newerRelease?.();
        await older;
        expect(order).toEqual([`newer`, `older`]);
    });

    it(`releases only once however often the caller calls it`, async () => {
        setStreamCapacity(() => 1);
        const first = await take();
        first?.();
        first?.();
        // A double release that decremented twice would let TWO streams past a capacity of one.
        expect(await take()).toEqual(expect.any(Function));
        let extra = false;
        void take().then(() => (extra = true));
        await Promise.resolve();
        expect(extra).toBe(false);
    });

    it(`stands down a caller aborted while queued, without stranding its slot`, async () => {
        setStreamCapacity(() => 1);
        const held = await take();
        const controller = new AbortController();
        const queued = take(controller.signal);
        controller.abort();
        expect(await queued).toBeUndefined();

        // The abandoned waiter must not still be holding a place in the queue: the next taker gets the slot.
        held?.();
        expect(await take()).toEqual(expect.any(Function));
    });

    it(`refuses an already-aborted caller before it opens anything`, async () => {
        setStreamCapacity(() => 4);
        expect(await take(AbortSignal.abort())).toBeUndefined();
    });

    it(`answers the free path without queuing: the abort gap there is the caller's to close`, async () => {
        /* Deliberately NOT "refuses a caller aborted during the acquire". On the unbounded path this function
         * runs to completion before the caller resumes, so an abort landing in that hop cannot be seen from in
         * here, no check inside would help. Closing it is the CALLER's job: conversation.ts re-reads the
         * signal after awaiting, because attaching on an already-aborted one parks forever instead of failing
         * (its producer wired teardown to an event that has already fired). This asserts the half that IS this
         * module's: the free path hands back a slot immediately, and releasing returns the capacity. */
        setStreamCapacity(() => Number.POSITIVE_INFINITY);
        const controller = new AbortController();
        const release = await take(controller.signal);

        controller.abort();
        release?.();
        setStreamCapacity(() => 1);
        expect(await take()).toEqual(expect.any(Function));
    });
});
