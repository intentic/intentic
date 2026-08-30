import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireStreamSlot,
    resetStreamBudget,
    setStreamCapacity,
    setStreamOverflow,
    streamCapacity,
    streamPermits,
    type StreamKind,
} from "./streamBudget";

beforeEach(() => {
    resetStreamBudget();
});

// A slot taken and immediately dropped on the floor: the shape most of these assertions need. The tests run
// without Web Locks (no such thing in the DOM stand-in), which is exactly the single-realm fallback path.
const take = async (signal?: AbortSignal): Promise<(() => void) | undefined> => acquireStreamSlot(`attach`, signal);

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

describe(`streamPermits`, () => {
    it(`splits the capped budget into pools that spend it exactly`, () => {
        // Disjoint and exhaustive: every permit belongs to one pool, and no permit is invented. A split that
        // summed to MORE than the capacity would hand out connections the browser does not have.
        const pools = streamPermits(`local-insecure`, `events`) + streamPermits(`local-insecure`, `attach`);
        expect(pools).toBe(streamCapacity(`local-insecure`));
    });

    it(`keeps a permit for liveness that the attaches cannot take`, () => {
        // /events is what makes a window live at all. Sharing one queue with the unbounded kind is how a
        // popped-out window ends up rendering a photograph of the workspace.
        expect(streamPermits(`local-insecure`, `events`)).toBeGreaterThan(0);
        expect(streamPermits(`local-insecure`, `attach`)).toBeGreaterThan(0);
    });

    it(`rations nothing on a transport that multiplexes`, () => {
        for (const stream of [`events`, `attach`] satisfies StreamKind[]) {
            expect(streamPermits(`tunnel`, stream)).toBe(Number.POSITIVE_INFINITY);
            expect(streamPermits(`local`, stream)).toBe(Number.POSITIVE_INFINITY);
        }
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

    it(`counts each kind against its own pool`, async () => {
        // The regression this file exists for: /events used to take a connection off the books entirely, so the
        // two held back for ordinary requests were really one. Saturating the attaches must not cost liveness
        // its permit.
        setStreamCapacity(() => 1);
        expect(await acquireStreamSlot(`attach`)).toEqual(expect.any(Function));
        expect(await acquireStreamSlot(`events`)).toEqual(expect.any(Function));
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

    it(`serves waiters in the order they asked, the order Web Locks grants in`, async () => {
        /* One queueing policy whichever primitive the browser provides, or the app behaves differently on a
         * browser with Web Locks than on one without. Which order is not the interesting property (nobody
         * waits long enough for it to hurt: see the deadline below); having only ONE of them is. */
        setStreamCapacity(() => 1);
        const held = await take();
        const order: string[] = [];
        let firstRelease: (() => void) | undefined;
        const first = take().then((release) => {
            order.push(`first`);
            firstRelease = release;
        });
        const second = take().then((release) => order.push(`second`) && release);

        held?.();
        await first;
        expect(order).toEqual([`first`]);

        // Parked, not dropped: the one behind it gets its turn as soon as the stream ahead ends.
        firstRelease?.();
        await second;
        expect(order).toEqual([`first`, `second`]);
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

    it(`leaves the transport rather than waiting forever on a permit that is not coming`, async () => {
        /* The deadline, and the reason it exists: waiting was the OLD answer and it is the wrong one. The
         * tunnel is sitting there speaking h2 with no cap, so a window that wants more streams than this
         * transport has moves to it (useEndpoint demotes) and opens anyway. Waiting instead is how a fifth
         * agent, or a third window, reads as "the workspace froze". */
        vi.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            const overflowed = vi.fn();
            setStreamOverflow(overflowed);
            await take();

            const queued = take();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(overflowed).toHaveBeenCalledOnce();
            // Admitted, not refused: undefined means "stand down", and the caller is about to open on a
            // transport where there is nothing to ration.
            expect(await queued).toEqual(expect.any(Function));
        } finally {
            vi.useRealTimers();
        }
    });

    it(`does not read a stream that gave up as an abort`, async () => {
        // The two refusals are told apart by re-reading the signal, and only one of them is the caller's own
        // doing. Confusing them would demote the endpoint every time a conversation was closed mid-queue.
        vi.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            const overflowed = vi.fn();
            setStreamOverflow(overflowed);
            await take();
            const controller = new AbortController();
            const queued = take(controller.signal);
            controller.abort();

            expect(await queued).toBeUndefined();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(overflowed).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
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
