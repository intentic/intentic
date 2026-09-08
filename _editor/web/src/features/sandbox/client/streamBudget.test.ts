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

// Acquires and discards a slot, the shape most assertions need. Runs without Web Locks in this DOM stand-in,
// exercising the single-realm fallback path.
const take = async (signal?: AbortSignal): Promise<(() => void) | undefined> => acquireStreamSlot(`attach`, signal);

describe(`streamCapacity`, () => {
    it(`only caps the transport that cannot multiplex`, () => {
        // h2 multiplexes many streams on one connection, so capping there would serialize for nothing.
        expect(streamCapacity(`local`)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(`public`)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(undefined)).toBe(Number.POSITIVE_INFINITY);
        // Plain http loopback is HTTP/1.1 and always will be: no browser speaks cleartext h2.
        expect(streamCapacity(`local-insecure`)).toBe(4);
    });

    it(`leaves the browser room for ordinary requests`, () => {
        // The point: connections are shared with ordinary requests, so streams may not claim all of them.
        expect(streamCapacity(`local-insecure`)).toBeLessThan(6);
    });
});

describe(`streamPermits`, () => {
    it(`splits the capped budget into pools that spend it exactly`, () => {
        // Disjoint and exhaustive: every permit belongs to one pool, and pools must never sum past capacity.
        const pools = streamPermits(`local-insecure`, `events`) + streamPermits(`local-insecure`, `attach`);
        expect(pools).toBe(streamCapacity(`local-insecure`));
    });

    it(`keeps a permit for liveness that the attaches cannot take`, () => {
        // /events makes a window live; sharing its queue with attaches is how a window ends up frozen on a stale view.
        expect(streamPermits(`local-insecure`, `events`)).toBeGreaterThan(0);
        expect(streamPermits(`local-insecure`, `attach`)).toBeGreaterThan(0);
    });

    it(`rations nothing on a transport that multiplexes`, () => {
        for (const stream of [`events`, `attach`] satisfies StreamKind[]) {
            expect(streamPermits(`public`, stream)).toBe(Number.POSITIVE_INFINITY);
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
        // Saturating the attaches must not cost /events its own permit.
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
        // One queueing policy regardless of the browser's primitive; the order itself isn't the point, having just one
        // is.
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
        // A double release that decremented twice would let two streams past a capacity of one.
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
        // The tunnel has no cap, so a stuck window demotes to it and opens instead of waiting; waiting instead reads as
        // a frozen workspace.
        vi.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            const overflowed = vi.fn();
            setStreamOverflow(overflowed);
            await take();

            const queued = take();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(overflowed).toHaveBeenCalledOnce();
            // Admitted, not refused: the caller opens on a transport with nothing to ration.
            expect(await queued).toEqual(expect.any(Function));
        } finally {
            vi.useRealTimers();
        }
    });

    it(`does not read a stream that gave up as an abort`, async () => {
        // Told apart by re-reading the signal; confusing a caller's own abort with an overflow would demote the
        // endpoint
        // on every closed conversation.
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
        // On the unbounded path, an abort during the synchronous acquire can't be observed here; closing that gap is
        // the
        // caller's job (conversation.ts re-checks after awaiting). This only asserts that release returns capacity on
        // the free path.
        setStreamCapacity(() => Number.POSITIVE_INFINITY);
        const controller = new AbortController();
        const release = await take(controller.signal);

        controller.abort();
        release?.();
        setStreamCapacity(() => 1);
        expect(await take()).toEqual(expect.any(Function));
    });
});
