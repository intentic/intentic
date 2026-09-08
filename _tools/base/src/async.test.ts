import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer, createBackoff, Delayer, narrate, pollUntil, retry, sleep, SingleFlight } from "./async.js";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe(`Delayer`, () => {
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
        // Asserted before the clock advances, or vitest reports the rejection as unhandled during the tick.
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

    it(`keeps working when add is detached from the instance`, () => {
        const flush = vi.fn();
        const { add } = new Coalescer<string>(50, flush);

        add(`detached`);
        vi.advanceTimersByTime(50);

        expect(flush).toHaveBeenCalledExactlyOnceWith([`detached`]);
    });

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

    it(`lets the next caller retry after a failed run`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = vi.fn().mockRejectedValueOnce(new Error(`transient`)).mockResolvedValueOnce(7);

        await expect(flight.run(`account`, task)).rejects.toThrow(`transient`);

        await expect(flight.run(`account`, task)).resolves.toBe(7);
        expect(flight.size).toBe(0);
    });

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

    it(`throws what the final attempt threw`, async () => {
        const task = vi.fn().mockRejectedValue(new Error(`still failing`));

        const pending = retry(task, 10, 3);
        const settled = expect(pending).rejects.toThrow(`still failing`);
        await vi.advanceTimersByTimeAsync(30);

        await settled;
        expect(task).toHaveBeenCalledTimes(3);
    });
});

describe(`sleep`, () => {
    it(`resolves after the delay`, async () => {
        let done = false;
        void sleep(100).then(() => {
            done = true;
        });
        await vi.advanceTimersByTimeAsync(99);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
    });

    it(`resolves early when the signal aborts, and at once for a signal already aborted`, async () => {
        const controller = new AbortController();
        let done = false;
        void sleep(10_000, { signal: controller.signal }).then(() => {
            done = true;
        });
        await vi.advanceTimersByTimeAsync(5);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toBe(true);

        const aborted = new AbortController();
        aborted.abort();
        await expect(sleep(10_000, { signal: aborted.signal })).resolves.toBeUndefined();
    });

    it(`leaves no listener behind on either path`, async () => {
        const controller = new AbortController();
        const added = vi.spyOn(controller.signal, `addEventListener`);
        const removed = vi.spyOn(controller.signal, `removeEventListener`);

        const pending = sleep(10, { signal: controller.signal });
        await vi.advanceTimersByTimeAsync(10);
        await pending;

        expect(added).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledTimes(1);
    });
});

describe(`pollUntil`, () => {
    it(`probes before consulting the clock, then every interval until the check passes`, async () => {
        let answers = 0;
        const check = vi.fn(() => ++answers >= 3);
        const outcome = pollUntil(check, { intervalMs: 50, timeoutMs: 10_000 });
        expect(check).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toBe(true);
        expect(check).toHaveBeenCalledTimes(3);
    });

    it(`answers false at the deadline and on abort, and propagates a throwing check`, async () => {
        const missed = pollUntil(() => false, { intervalMs: 50, timeoutMs: 120 });
        await vi.advanceTimersByTimeAsync(200);
        await expect(missed).resolves.toBe(false);

        const controller = new AbortController();
        const aborted = pollUntil(() => false, { intervalMs: 50, timeoutMs: 10_000, signal: controller.signal });
        await vi.advanceTimersByTimeAsync(10);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        await expect(aborted).resolves.toBe(false);

        await expect(
            pollUntil(
                () => {
                    throw new Error(`gone`);
                },
                { intervalMs: 50, timeoutMs: 10_000 },
            ),
        ).rejects.toThrow(`gone`);
    });

    it(`a deadline already past still gets its one probe`, async () => {
        await expect(pollUntil(() => true, { intervalMs: 50, timeoutMs: 0 })).resolves.toBe(true);
        await expect(pollUntil(() => false, { intervalMs: 50, timeoutMs: 0 })).resolves.toBe(false);
    });

    it(`runs onRetry only when another probe is coming`, async () => {
        const onRetry = vi.fn();
        const missed = pollUntil(() => false, { intervalMs: 50, timeoutMs: 120, onRetry });
        await vi.advanceTimersByTimeAsync(200);
        await expect(missed).resolves.toBe(false);
        expect(onRetry).toHaveBeenCalledTimes(3);

        onRetry.mockClear();
        await expect(pollUntil(() => true, { intervalMs: 50, timeoutMs: 10_000, onRetry })).resolves.toBe(true);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it(`runs on an injected clock, so a long wait costs a test nothing`, async () => {
        let clock = 0;
        const wait = vi.fn(async (ms: number) => {
            clock += ms;
        });
        let answers = 0;
        await expect(pollUntil(() => ++answers >= 4, { intervalMs: 30_000, timeoutMs: 600_000, now: () => clock, wait })).resolves.toBe(true);
        expect(wait).toHaveBeenCalledTimes(3);
        expect(clock).toBe(90_000);

        clock = 0;
        await expect(pollUntil(() => false, { intervalMs: 30_000, timeoutMs: 60_000, now: () => clock, wait })).resolves.toBe(false);
        expect(clock).toBe(60_000);
    });
});

describe(`createBackoff`, () => {
    it(`climbs from the floor by doubling and holds at the cap`, () => {
        const ladder = createBackoff({ floorMs: 1_000, capMs: 5_000 });
        expect([ladder.next(), ladder.next(), ladder.next(), ladder.next(), ladder.next()]).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
        ladder.reset();
        expect(ladder.next()).toBe(1_000);
    });

    it(`a run that stayed up past stableMs earns the floor back; a short one keeps climbing`, () => {
        const ladder = createBackoff({ floorMs: 1_000, capMs: 30_000, stableMs: 60_000 });
        expect([ladder.next(100), ladder.next(100), ladder.next(100)]).toEqual([1_000, 2_000, 4_000]);
        expect(ladder.next(60_000)).toBe(1_000);
        expect(ladder.next(59_999)).toBe(2_000);
        expect(ladder.next()).toBe(4_000);
    });

    // random()=1 lands on the next rung, random()=0 on the floor: full jitter, not a fixed schedule.
    it(`jitters each wait between the floor and the next rung`, () => {
        const ceilings = createBackoff({ floorMs: 1_000, capMs: 30_000, random: () => 1 });
        expect([ceilings.next(), ceilings.next(), ceilings.next()]).toEqual([2_000, 4_000, 8_000]);
        const floors = createBackoff({ floorMs: 1_000, capMs: 30_000, random: () => 0 });
        expect([floors.next(), floors.next(), floors.next()]).toEqual([1_000, 1_000, 1_000]);
        const halfway = createBackoff({ floorMs: 1_000, capMs: 30_000, random: () => 0.5 });
        expect(halfway.next()).toBe(1_500);
    });
});

describe(`narrate`, () => {
    type Frame = { kind: "line"; text: string } | { kind: "done"; ok: boolean; detail?: string };
    const end = (outcome: { ok: true; value: string } | { ok: false; error: string }): Frame =>
        outcome.ok ? { kind: `done`, ok: true, detail: outcome.value } : { kind: `done`, ok: false, detail: outcome.error };

    const drain = async (stream: AsyncGenerator<Frame>): Promise<Frame[]> => {
        const frames: Frame[] = [];
        for await (const frame of stream) {
            frames.push(frame);
        }
        return frames;
    };

    it(`yields every line in order, then one terminal frame`, async () => {
        const frames = await drain(
            narrate(async (onLine) => {
                onLine(`pulling`);
                onLine(`extracting`);
                return `up`;
            }, end),
        );
        expect(frames).toEqual([
            { kind: `line`, text: `pulling` },
            { kind: `line`, text: `extracting` },
            { kind: `done`, ok: true, detail: `up` },
        ]);
    });

    it(`reports a rejection as a terminal frame, keeping the lines that came before it`, async () => {
        const frames = await drain(
            narrate(async (onLine) => {
                onLine(`starting`);
                throw new Error(`no such image`);
            }, end),
        );
        expect(frames).toEqual([
            { kind: `line`, text: `starting` },
            { kind: `done`, ok: false, detail: `no such image` },
        ]);
    });

    it(`queues lines produced while nothing is reading`, async () => {
        let emit: ((line: string) => void) | undefined;
        const stream = narrate((onLine) => {
            emit = onLine;
            return sleep(50).then(() => `done`);
        }, end);
        const first = stream.next();
        emit!(`a`);
        emit!(`b`);
        expect((await first).value).toEqual({ kind: `line`, text: `a` });
        expect((await stream.next()).value).toEqual({ kind: `line`, text: `b` });
        const rest = drain(stream as AsyncGenerator<Frame>);
        await vi.advanceTimersByTimeAsync(50);
        expect(await rest).toEqual([{ kind: `done`, ok: true, detail: `done` }]);
    });
});
