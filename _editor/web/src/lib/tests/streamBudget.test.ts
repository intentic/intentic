import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import {
    acquireStreamSlot,
    measuredProtocol,
    recordProtocols,
    resetStreamBudget,
    setStreamCapacity,
    setStreamOverflow,
    streamCapacity,
    streamPermits,
    type StreamKind,
} from "../streamBudget";

beforeEach(() => {
    resetStreamBudget();
});

// Acquires and discards a slot, the shape most assertions need. Runs without Web Locks in this DOM stand-in,
// exercising the single-realm fallback path.
const take = async (signal?: AbortSignal): Promise<(() => void) | undefined> => acquireStreamSlot(`attach`, signal);

describe(`streamCapacity`, () => {
    it(`caps whatever the browser did not negotiate as h2 or h3, on any address`, () => {
        // The Linux app's WebKitGTK spoke HTTP/1.1 to the certified loopback name, which was assumed h2 by its kind.
        for (const kind of [`local`, `local-insecure`, `public`] as const) {
            expect(streamCapacity(kind, `http/1.1`)).toBe(4);
            expect(streamCapacity(kind, `h2`)).toBe(Number.POSITIVE_INFINITY);
            expect(streamCapacity(kind, `h3`)).toBe(Number.POSITIVE_INFINITY);
        }
    });

    it(`reads an unmeasured loopback route as HTTP/1.1 under WebKit and an unmeasured tunnel as multiplexed`, () => {
        expect(streamCapacity(`local`, undefined, true)).toBe(4);
        expect(streamCapacity(`local-insecure`, undefined, true)).toBe(4);
        expect(streamCapacity(`public`, undefined, true)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(undefined, undefined, true)).toBe(Number.POSITIVE_INFINITY);
    });

    // A netd too old to send Timing-Allow-Origin leaves the protocol unknown for good: Blink and Gecko reach the
    // certified loopback name over h2, so capping them there would push a third window or stream to the tunnel.
    it(`leaves the certified loopback name uncapped for engines that multiplex it, and plain HTTP capped for all`, () => {
        expect(streamCapacity(`local`, undefined, false)).toBe(Number.POSITIVE_INFINITY);
        expect(streamCapacity(`local-insecure`, undefined, false)).toBe(4);
        expect(streamCapacity(`local`, `http/1.1`, false)).toBe(4);
    });

    it(`leaves the browser room for ordinary requests`, () => {
        // The point: connections are shared with ordinary requests, so streams may not claim all of them.
        expect(streamCapacity(`local`, `http/1.1`)).toBeLessThan(6);
    });
});

describe(`measuredProtocol`, () => {
    const timing = (name: string, nextHopProtocol: string) => ({ name, nextHopProtocol });

    it(`knows an origin's protocol once one of its responses was timed, and nothing before`, () => {
        expect(measuredProtocol(`https://box.example:4750`)).toBeUndefined();
        recordProtocols([timing(`https://box.example:4750/health`, `http/1.1`), timing(`https://tunnel.example/health`, `h2`)]);
        expect(measuredProtocol(`https://box.example:4750`)).toBe(`http/1.1`);
        expect(measuredProtocol(`https://tunnel.example`)).toBe(`h2`);
        expect(measuredProtocol(`https://box.example:4751`)).toBeUndefined();
    });

    it(`keeps what it knew through a response that hides its timing`, () => {
        // A cross-origin response without Timing-Allow-Origin reads as "", which says nothing about the connection.
        recordProtocols([timing(`https://box.example/health`, `h2`), timing(`https://box.example/agent/attach`, ``)]);
        expect(measuredProtocol(`https://box.example`)).toBe(`h2`);
    });
});

describe(`streamPermits`, () => {
    it(`splits the capped budget into pools that spend it exactly`, () => {
        // Disjoint and exhaustive: every permit belongs to one pool, and pools must never sum past capacity.
        const pools = streamPermits(`local`, undefined, `events`) + streamPermits(`local`, undefined, `attach`);
        expect(pools).toBe(streamCapacity(`local`, undefined));
    });

    it(`keeps a permit for liveness that the attaches cannot take`, () => {
        // /events makes a window live; sharing its queue with attaches is how a window ends up frozen on a stale view.
        expect(streamPermits(`local`, `http/1.1`, `events`)).toBe(2);
        expect(streamPermits(`local`, `http/1.1`, `attach`)).toBe(2);
    });

    it(`rations nothing on a transport that multiplexes`, () => {
        for (const stream of [`events`, `attach`] satisfies StreamKind[]) {
            expect(streamPermits(`local`, `h2`, stream)).toBe(Number.POSITIVE_INFINITY);
            expect(streamPermits(`public`, `h3`, stream)).toBe(Number.POSITIVE_INFINITY);
            expect(streamPermits(`public`, undefined, stream)).toBe(Number.POSITIVE_INFINITY);
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
        // Use one queueing policy regardless of the browser primitive.
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
        jest.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            const overflowed = jest.fn();
            setStreamOverflow(() => {
                overflowed();
                return true;
            });
            await take();

            const queued = take();
            await advanceTimersByTimeAsync(10_000);
            expect(overflowed).toHaveBeenCalledTimes(1);
            // Admitted, not refused: the caller opens on a transport with nothing to ration.
            expect(await queued).toEqual(expect.any(Function));
        } finally {
            jest.useRealTimers();
        }
    });

    it(`keeps short-request connections reserved when no alternate transport exists`, async () => {
        jest.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            setStreamOverflow(() => false);
            const release = await take();
            const queued = take();
            let admitted = false;
            void queued.then(() => {
                admitted = true;
            });
            await advanceTimersByTimeAsync(10_000);
            expect(admitted).toBe(false);
            release?.();
            expect(await queued).toEqual(expect.any(Function));
        } finally {
            jest.useRealTimers();
        }
    });

    it(`still opens a window's one /events stream when no alternate transport exists`, async () => {
        // Waiting there would leave the window never live; one stream past the pool costs a reserved connection.
        jest.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            setStreamOverflow(() => false);
            await acquireStreamSlot(`events`);
            const queued = acquireStreamSlot(`events`);
            await advanceTimersByTimeAsync(5_000);
            expect(await queued).toEqual(expect.any(Function));
        } finally {
            jest.useRealTimers();
        }
    });

    it(`does not read a stream that gave up as an abort`, async () => {
        // Told apart by re-reading the signal; confusing a caller's own abort with an overflow would demote the
        // endpoint
        // on every closed conversation.
        jest.useFakeTimers();
        try {
            setStreamCapacity(() => 1);
            const overflowed = jest.fn();
            setStreamOverflow(overflowed);
            await take();
            const controller = new AbortController();
            const queued = take(controller.signal);
            controller.abort();

            expect(await queued).toBeUndefined();
            await advanceTimersByTimeAsync(10_000);
            expect(overflowed).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
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
