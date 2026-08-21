import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer, Delayer, retry, SingleFlight } from "./async.js";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe(`Delayer`, () => {
    /* The half of the pair that RESTARTS its clock. Two calls 5ms apart under a 50ms delay produce one run,
     * 50ms after the second: a search box, not a watcher. */
    it(`runs once after the caller goes quiet`, async () => {
        const delayer = new Delayer<string>(50);
        const task = vi.fn(() => `done`);

        const first = delayer.trigger(task);
        await vi.advanceTimersByTimeAsync(5);
        const second = delayer.trigger(task);
        await vi.advanceTimersByTimeAsync(49);
        expect(task).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(task).toHaveBeenCalledOnce();
        await expect(first).resolves.toBe(`done`);
        await expect(second).resolves.toBe(`done`);
    });

    it(`runs the task given by the LAST trigger of the window`, async () => {
        const delayer = new Delayer<string>(10);
        void delayer.trigger(() => `stale`);

        const latest = delayer.trigger(() => `latest`);

        await vi.advanceTimersByTimeAsync(10);
        await expect(latest).resolves.toBe(`latest`);
    });

    it(`rejects the window's promise when the task throws`, async () => {
        const delayer = new Delayer<string>(10);
        // Asserted BEFORE the clock advances: attaching the handler afterwards leaves the rejection unhandled
        // for the length of the tick, which vitest reports as an error even though the test passes.
        const settled = expect(
            delayer.trigger(() => {
                throw new Error(`task failed`);
            }),
        ).rejects.toThrow(`task failed`);

        await vi.advanceTimersByTimeAsync(10);

        await settled;
    });

    it(`drops the pending run when disposed`, async () => {
        const delayer = new Delayer<string>(10);
        const task = vi.fn(() => `done`);
        void delayer.trigger(task);

        delayer.dispose();
        await vi.advanceTimersByTimeAsync(100);

        expect(task).not.toHaveBeenCalled();
        expect(delayer.isPending).toBe(false);
    });
});

describe(`Coalescer`, () => {
    /* The half that does NOT restart. This is the whole reason both exist: a source that never goes quiet:
     * an agent editing continuously: starves a Delayer, and a watcher that only reports once the agent stops
     * reports when the browser no longer needs telling. */
    it(`flushes on the window opened by the first item, however long the burst runs`, () => {
        const flush = vi.fn();
        const coalescer = new Coalescer<string>(50, flush);

        coalescer.add(`a`);
        vi.advanceTimersByTime(40);
        coalescer.add(`b`);
        vi.advanceTimersByTime(10);

        expect(flush).toHaveBeenCalledExactlyOnceWith([`a`, `b`]);
    });

    it(`opens a fresh window for what arrives after a flush`, () => {
        const flush = vi.fn();
        const coalescer = new Coalescer<string>(50, flush);
        coalescer.add(`first`);
        vi.advanceTimersByTime(50);

        coalescer.add(`second`);
        vi.advanceTimersByTime(50);

        expect(flush).toHaveBeenNthCalledWith(2, [`second`]);
    });

    // Handed to a watcher or a worker port as the callback, which is how every caller here uses it.
    it(`keeps working when add is detached from the instance`, () => {
        const flush = vi.fn();
        const { add } = new Coalescer<string>(50, flush);

        add(`detached`);
        vi.advanceTimersByTime(50);

        expect(flush).toHaveBeenCalledExactlyOnceWith([`detached`]);
    });

    // Nothing added, nothing scheduled: an idle coalescer must not be a timer waking the process on a window
    // that has no batch behind it.
    it(`never flushes an empty batch`, () => {
        const flush = vi.fn();
        const idle = new Coalescer<string>(50, flush);

        vi.advanceTimersByTime(100);

        expect(flush).not.toHaveBeenCalled();
        expect(idle.isPending).toBe(false);
    });

    it(`emits what it holds on flushNow, and drops it on dispose`, () => {
        const flush = vi.fn();
        const coalescer = new Coalescer<string>(50, flush);
        coalescer.add(`held`);

        coalescer.flushNow();
        expect(flush).toHaveBeenCalledExactlyOnceWith([`held`]);

        coalescer.add(`dropped`);
        coalescer.dispose();
        vi.advanceTimersByTime(100);
        expect(flush).toHaveBeenCalledOnce();
    });
});

describe(`SingleFlight`, () => {
    /* The property a token refresh depends on. A second concurrent caller must JOIN the run in flight, not
     * start its own: presenting a refresh token twice is what some providers answer by revoking the grant. */
    it(`shares one run between concurrent callers for the same key`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 42;
        });

        const both = Promise.all([flight.run(`account`, task), flight.run(`account`, task)]);
        await vi.advanceTimersByTimeAsync(10);

        expect(task).toHaveBeenCalledOnce();
        await expect(both).resolves.toEqual([42, 42]);
    });

    it(`runs different keys independently`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = vi.fn(async () => 1);

        await Promise.all([flight.run(`one`, task), flight.run(`other`, task)]);

        expect(task).toHaveBeenCalledTimes(2);
    });

    // A failure must not be cached as a rejection forever: the next caller has to be able to try again.
    it(`lets the next caller retry after a failed run`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = vi.fn().mockRejectedValueOnce(new Error(`transient`)).mockResolvedValueOnce(7);

        await expect(flight.run(`account`, task)).rejects.toThrow(`transient`);

        await expect(flight.run(`account`, task)).resolves.toBe(7);
        expect(flight.size).toBe(0);
    });

    // Joining without starting: a reader that must wait out a run in progress but has no business beginning one.
    it(`hands back the run in flight, and nothing once it has settled`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 1;
        });
        const started = flight.run(`account`, task);
        const joined = flight.joined(`account`);
        expect(joined).toBe(started);

        await vi.advanceTimersByTimeAsync(10);
        await started;

        expect(flight.joined(`account`)).toBeUndefined();
        expect(task).toHaveBeenCalledOnce();
    });

    it(`has nothing to join for a key that was never run`, () => {
        expect(new SingleFlight<string, number>().joined(`absent`)).toBeUndefined();
    });
});

describe(`retry`, () => {
    it(`returns the first success without waiting again`, async () => {
        const task = vi.fn().mockRejectedValueOnce(new Error(`once`)).mockResolvedValueOnce(`ok`);

        const pending = retry(task, 10, 3);
        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toBe(`ok`);
        expect(task).toHaveBeenCalledTimes(2);
    });

    /* Throwing the LAST attempt's error rather than a summary of its own: "retries exhausted" tells a caller
     * nothing it can act on, and the provider's 401 tells it everything. */
    it(`throws what the final attempt threw`, async () => {
        const task = vi.fn().mockRejectedValue(new Error(`still failing`));

        const pending = retry(task, 10, 3);
        const settled = expect(pending).rejects.toThrow(`still failing`);
        await vi.advanceTimersByTimeAsync(30);

        await settled;
        expect(task).toHaveBeenCalledTimes(3);
    });
});
