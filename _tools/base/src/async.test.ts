import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import {
    anySignal,
    Coalescer,
    createBackoff,
    Delayer,
    keyedLock,
    Latest,
    narrate,
    pollFor,
    pollUntil,
    retry,
    serialLock,
    sleep,
    SingleFlight,
    TimeoutError,
    unlessAborted,
    watchQueue,
    whenAborted,
    withDeadline,
    within,
    withTimeout,
} from "./async.js";

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe(`Delayer`, () => {
    it(`runs once after the caller goes quiet`, async () => {
        const delayer = new Delayer<string>(50);
        const task = jest.fn(() => `done`);

        const first = delayer.trigger(task);
        await advanceTimersByTimeAsync(5);
        const second = delayer.trigger(task);
        await advanceTimersByTimeAsync(49);
        expect(task).not.toHaveBeenCalled();

        await advanceTimersByTimeAsync(1);
        expect(task).toHaveBeenCalledTimes(1);
        await expect(first).resolves.toBe(`done`);
        await expect(second).resolves.toBe(`done`);
    });

    it(`runs the task given by the LAST trigger of the window`, async () => {
        const delayer = new Delayer<string>(10);
        void delayer.trigger(() => `stale`);

        const latest = delayer.trigger(() => `latest`);

        await advanceTimersByTimeAsync(10);
        await expect(latest).resolves.toBe(`latest`);
    });

    it(`rejects the window's promise when the task throws`, async () => {
        const delayer = new Delayer<string>(10);
        // Caught before the clock advances, or the runner reports the rejection as unhandled during the tick.
        const settled = delayer
            .trigger((): string => {
                throw new Error(`task failed`);
            })
            .catch((error: unknown) => error);

        await advanceTimersByTimeAsync(10);

        expect(await settled).toMatchObject({ message: `task failed` });
    });

    it(`drops the pending run when disposed`, async () => {
        const delayer = new Delayer<string>(10);
        const task = jest.fn(() => `done`);
        void delayer.trigger(task);

        delayer.dispose();
        await advanceTimersByTimeAsync(100);

        expect(task).not.toHaveBeenCalled();
        expect(delayer.isPending).toBe(false);
    });
});

describe(`Coalescer`, () => {
    it(`flushes on the window opened by the first item, however long the burst runs`, () => {
        const flush = jest.fn();
        const coalescer = new Coalescer<string>(50, flush);

        coalescer.add(`a`);
        jest.advanceTimersByTime(40);
        coalescer.add(`b`);
        jest.advanceTimersByTime(10);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith([`a`, `b`]);
    });

    it(`opens a fresh window for what arrives after a flush`, () => {
        const flush = jest.fn();
        const coalescer = new Coalescer<string>(50, flush);
        coalescer.add(`first`);
        jest.advanceTimersByTime(50);

        coalescer.add(`second`);
        jest.advanceTimersByTime(50);

        expect(flush).toHaveBeenNthCalledWith(2, [`second`]);
    });

    it(`keeps working when add is detached from the instance`, () => {
        const flush = jest.fn();
        const { add } = new Coalescer<string>(50, flush);

        add(`detached`);
        jest.advanceTimersByTime(50);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith([`detached`]);
    });

    it(`never flushes an empty batch`, () => {
        const flush = jest.fn();
        const idle = new Coalescer<string>(50, flush);

        jest.advanceTimersByTime(100);

        expect(flush).not.toHaveBeenCalled();
        expect(idle.isPending).toBe(false);
    });

    it(`emits what it holds on flushNow, and drops it on dispose`, () => {
        const flush = jest.fn();
        const coalescer = new Coalescer<string>(50, flush);
        coalescer.add(`held`);

        coalescer.flushNow();
        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith([`held`]);

        coalescer.add(`dropped`);
        coalescer.dispose();
        jest.advanceTimersByTime(100);
        expect(flush).toHaveBeenCalledTimes(1);
    });
});

describe(`SingleFlight`, () => {
    it(`shares one run between concurrent callers for the same key`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = jest.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 42;
        });

        const both = Promise.all([flight.run(`account`, task), flight.run(`account`, task)]);
        await advanceTimersByTimeAsync(10);

        expect(task).toHaveBeenCalledTimes(1);
        await expect(both).resolves.toEqual([42, 42]);
    });

    it(`runs different keys independently`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = jest.fn(async () => 1);

        await Promise.all([flight.run(`one`, task), flight.run(`other`, task)]);

        expect(task).toHaveBeenCalledTimes(2);
    });

    it(`lets the next caller retry after a failed run`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = jest.fn().mockRejectedValueOnce(new Error(`transient`)).mockResolvedValueOnce(7);

        await expect(flight.run(`account`, task)).rejects.toThrow(`transient`);

        await expect(flight.run(`account`, task)).resolves.toBe(7);
        expect(flight.size).toBe(0);
    });

    it(`hands back the run in flight, and nothing once it has settled`, async () => {
        const flight = new SingleFlight<string, number>();
        const task = jest.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 1;
        });
        const started = flight.run(`account`, task);
        const joined = flight.joined(`account`);
        expect(joined).toBe(started);

        await advanceTimersByTimeAsync(10);
        await started;

        expect(flight.joined(`account`)).toBeUndefined();
        expect(task).toHaveBeenCalledTimes(1);
    });

    it(`has nothing to join for a key that was never run`, () => {
        expect(new SingleFlight<string, number>().joined(`absent`)).toBeUndefined();
    });
});

describe(`keyedLock`, () => {
    it(`runs one task at a time per key, the next after the last however it ended`, async () => {
        const lock = keyedLock<string>();
        const order: string[] = [];
        const slow = (name: string, fail = false) => async (): Promise<string> => {
            order.push(`${name} start`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push(`${name} end`);
            if (fail) {
                throw new Error(name);
            }
            return name;
        };

        const first = lock(`repo`, slow(`first`, true));
        const second = lock(`repo`, slow(`second`));
        const other = lock(`other`, slow(`other`));
        await advanceTimersByTimeAsync(20);

        await expect(first).rejects.toThrow(`first`);
        await expect(second).resolves.toBe(`second`);
        await expect(other).resolves.toBe(`other`);
        expect(order.filter((step) => !step.startsWith(`other`))).toEqual([`first start`, `first end`, `second start`, `second end`]);
        // Another key never waits on this one's queue.
        expect(order.indexOf(`other start`)).toBeLessThan(order.indexOf(`first end`));
    });
});

describe(`serialLock`, () => {
    it(`runs one task at a time, the next after the last however it ended`, async () => {
        const serially = serialLock();
        const order: string[] = [];
        const slow = (name: string, fail = false) => async (): Promise<string> => {
            order.push(`${name} start`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push(`${name} end`);
            if (fail) {
                throw new Error(name);
            }
            return name;
        };

        const first = serially(slow(`first`, true));
        const second = serially(slow(`second`));
        await advanceTimersByTimeAsync(20);

        await expect(first).rejects.toThrow(`first`);
        await expect(second).resolves.toBe(`second`);
        expect(order).toEqual([`first start`, `first end`, `second start`, `second end`]);
    });
});

describe(`sleep`, () => {
    it(`resolves after the delay`, async () => {
        let done = false;
        void sleep(100).then(() => {
            done = true;
        });
        await advanceTimersByTimeAsync(99);
        expect(done).toBe(false);
        await advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
    });

    it(`resolves early when the signal aborts, and at once for a signal already aborted`, async () => {
        const controller = new AbortController();
        let done = false;
        void sleep(10_000, { signal: controller.signal }).then(() => {
            done = true;
        });
        await advanceTimersByTimeAsync(5);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        expect(done).toBe(true);

        const aborted = new AbortController();
        aborted.abort();
        await expect(sleep(10_000, { signal: aborted.signal })).resolves.toBeUndefined();
    });

    it(`leaves no listener behind on either path`, async () => {
        const controller = new AbortController();
        const added = jest.spyOn(controller.signal, `addEventListener`);
        const removed = jest.spyOn(controller.signal, `removeEventListener`);

        const pending = sleep(10, { signal: controller.signal });
        await advanceTimersByTimeAsync(10);
        await pending;

        expect(added).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledTimes(1);
    });
});

describe(`withTimeout`, () => {
    it(`answers with the promise when it settles in time, and leaves no timer behind`, async () => {
        const cleared = jest.spyOn(globalThis, `clearTimeout`);
        try {
            await expect(withTimeout(Promise.resolve(`ok`), 1_000, `slow`)).resolves.toBe(`ok`);
            await expect(withTimeout(Promise.reject(new Error(`own`)), 1_000, `slow`)).rejects.toThrow(`own`);
            expect(cleared).toHaveBeenCalledTimes(2);
        } finally {
            cleared.mockRestore();
        }
    });

    it(`rejects with the message at the deadline and not a tick before`, async () => {
        const settled = withTimeout(new Promise<never>(() => undefined), 100, `Timed out reading notes`).catch((error: unknown) => error);
        let done = false;
        void settled.then(() => {
            done = true;
        });
        await advanceTimersByTimeAsync(99);
        expect(done).toBe(false);
        await advanceTimersByTimeAsync(1);
        expect(await settled).toMatchObject({ message: `Timed out reading notes` });
    });

    it(`names the wait when no message is given`, async () => {
        const settled = withTimeout(new Promise<never>(() => undefined), 50).catch((error: unknown) => error);
        await advanceTimersByTimeAsync(50);
        expect(await settled).toMatchObject({ message: `timed out after 50ms` });
    });
});

describe(`pollUntil`, () => {
    it(`probes before consulting the clock, then every interval until the check passes`, async () => {
        let answers = 0;
        const check = jest.fn(() => ++answers >= 3);
        const outcome = pollUntil(check, { intervalMs: 50, timeoutMs: 10_000 });
        expect(check).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toBe(true);
        expect(check).toHaveBeenCalledTimes(3);
    });

    it(`answers false at the deadline and on abort, and propagates a throwing check`, async () => {
        const missed = pollUntil(() => false, { intervalMs: 50, timeoutMs: 120 });
        await advanceTimersByTimeAsync(200);
        await expect(missed).resolves.toBe(false);

        const controller = new AbortController();
        const aborted = pollUntil(() => false, { intervalMs: 50, timeoutMs: 10_000, signal: controller.signal });
        await advanceTimersByTimeAsync(10);
        controller.abort();
        await advanceTimersByTimeAsync(0);
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
        const onRetry = jest.fn();
        const missed = pollUntil(() => false, { intervalMs: 50, timeoutMs: 120, onRetry });
        await advanceTimersByTimeAsync(200);
        await expect(missed).resolves.toBe(false);
        expect(onRetry).toHaveBeenCalledTimes(3);

        onRetry.mockClear();
        await expect(pollUntil(() => true, { intervalMs: 50, timeoutMs: 10_000, onRetry })).resolves.toBe(true);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it(`runs on an injected clock, so a long wait costs a test nothing`, async () => {
        let clock = 0;
        const wait = jest.fn(async (ms: number) => {
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
    // random()=1 reads each rung's ceiling, the top of its draw, so these two read the ladder itself.
    it(`doubles the ceiling from the floor and holds it at the cap`, () => {
        const ladder = createBackoff({ floorMs: 1_000, capMs: 5_000, random: () => 1 });
        expect([ladder.next(), ladder.next(), ladder.next(), ladder.next(), ladder.next()]).toEqual([2_000, 4_000, 5_000, 5_000, 5_000]);
        ladder.reset();
        expect(ladder.next()).toBe(2_000);
    });

    it(`a run that stayed up past stableMs earns the floor back; a short one keeps climbing`, () => {
        const ladder = createBackoff({ floorMs: 1_000, capMs: 30_000, stableMs: 60_000, random: () => 1 });
        expect([ladder.next(100), ladder.next(100), ladder.next(100)]).toEqual([2_000, 4_000, 8_000]);
        expect(ladder.next(60_000)).toBe(2_000);
        expect(ladder.next(59_999)).toBe(4_000);
        expect(ladder.next()).toBe(8_000);
    });

    // Every client of a restarted daemon drops on the same tick; a ladder nobody gave a `random` must still spread them.
    it(`jitters by default, drawing from Math.random`, () => {
        const draw = jest.spyOn(Math, `random`).mockReturnValue(0.25);
        try {
            const ladder = createBackoff({ floorMs: 1_000, capMs: 30_000 });
            expect([ladder.next(), ladder.next()]).toEqual([1_250, 1_750]);
            expect(draw).toHaveBeenCalledTimes(2);
        } finally {
            draw.mockRestore();
        }
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
        await advanceTimersByTimeAsync(50);
        expect(await rest).toEqual([{ kind: `done`, ok: true, detail: `done` }]);
    });
});

describe(`whenAborted`, () => {
    test("a signal that aborted before anyone listened still runs the handler", () => {
        const controller = new AbortController();
        controller.abort();
        let ran = 0;
        whenAborted(controller.signal, () => {
            ran += 1;
        });
        // The bare listener this replaces would leave `ran` at 0: the abort event fired before registration and is
        // never replayed, which is how a Stop clicked during a provider's connect handshake used to be dropped.
        expect(ran).toBe(1);
    });

    test("the handler runs synchronously, so the line after the registration already sees the cancellation", () => {
        const controller = new AbortController();
        controller.abort();
        let killed = false;
        whenAborted(controller.signal, () => {
            killed = true;
        });
        expect(killed).toBe(true);
    });

    test("a live signal fires the handler once, when it aborts", () => {
        const controller = new AbortController();
        let ran = 0;
        whenAborted(controller.signal, () => {
            ran += 1;
        });
        expect(ran).toBe(0);
        controller.abort();
        controller.abort();
        expect(ran).toBe(1);
    });

    test("the returned dispose removes a handler that has not fired", () => {
        const controller = new AbortController();
        let ran = 0;
        const dispose = whenAborted(controller.signal, () => {
            ran += 1;
        });
        dispose();
        controller.abort();
        expect(ran).toBe(0);
    });

    test("dispose is safe after the handler already ran, and safe with no signal at all", () => {
        const controller = new AbortController();
        let ran = 0;
        const dispose = whenAborted(controller.signal, () => {
            ran += 1;
        });
        controller.abort();
        expect(ran).toBe(1);
        expect(() => dispose()).not.toThrow();
        expect(ran).toBe(1);

        let neverRan = 0;
        const disposeNothing = whenAborted(undefined, () => {
            neverRan += 1;
        });
        expect(() => disposeNothing()).not.toThrow();
        expect(neverRan).toBe(0);
    });

    test("an already-aborted signal still hands back a dispose that does not re-run the handler", () => {
        const controller = new AbortController();
        controller.abort();
        let ran = 0;
        const dispose = whenAborted(controller.signal, () => {
            ran += 1;
        });
        expect(ran).toBe(1);
        dispose();
        expect(ran).toBe(1);
    });
});

describe("watchQueue", () => {
    it("yields what was pushed in order, including what was pushed before an abort", async () => {
        const abort = new AbortController();
        const watch = watchQueue<number>({ signal: abort.signal, until: Date.now() + 60_000, longestMs: 60_000 });
        watch.push(1);
        watch.push(2);
        abort.abort();
        const seen: number[] = [];
        for await (const value of watch.drain()) {
            seen.push(value);
        }
        expect(seen).toEqual([1, 2]);
    });

    it("ends at `until`, or at `longestMs` when that comes first", async () => {
        jest.useFakeTimers();
        try {
            const near = watchQueue<number>({ until: Date.now() + 1_000, longestMs: 60_000 }).drain();
            const nearEnd = near.next();
            await advanceTimersByTimeAsync(1_000);
            expect(await nearEnd).toEqual({ done: true, value: undefined });

            const far = watchQueue<number>({ until: Date.now() + 3_600_000, longestMs: 60_000 }).drain();
            const farEnd = far.next();
            await advanceTimersByTimeAsync(59_999);
            let settled = false;
            void farEnd.then(() => (settled = true));
            await advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);
            await advanceTimersByTimeAsync(1);
            expect(await farEnd).toEqual({ done: true, value: undefined });
        } finally {
            jest.useRealTimers();
        }
    });

    it("wakes a waiting reader on a push", async () => {
        const watch = watchQueue<string>({ until: Date.now() + 60_000, longestMs: 60_000 });
        const reader = watch.drain();
        const first = reader.next();
        watch.push("landed");
        expect(await first).toEqual({ done: false, value: "landed" });
        await reader.return(undefined);
    });
});

describe(`SingleFlight after dispose`, () => {
    it(`keeps a run started after a dispose joinable when the run from before it settles`, async () => {
        const flight = new SingleFlight<string, string>();
        const { promise: before, resolve: finishBefore } = Promise.withResolvers<string>();
        void flight.run(`k`, () => before);
        flight.dispose();
        const { promise: after } = Promise.withResolvers<string>();
        const current = flight.run(`k`, () => after);
        finishBefore(`old`);
        await before;
        await Promise.resolve();
        expect(flight.joined(`k`)).toBe(current);
    });
});

describe(`Latest`, () => {
    it(`aborts the attempt before when the next one starts, and only that one`, () => {
        const latest = new Latest();
        const first = latest.next();
        const second = latest.next();
        expect(first.aborted).toBe(true);
        expect(second.aborted).toBe(false);
        expect(latest.isCurrent(first)).toBe(false);
        expect(latest.isCurrent(second)).toBe(true);
        expect(latest.current).toBe(second);
    });

    it(`lets a finished attempt go without aborting it, and leaves a newer one alone`, () => {
        const latest = new Latest();
        const first = latest.next();
        const second = latest.next();
        latest.done(first);
        expect(latest.current).toBe(second);
        latest.done(second);
        expect(second.aborted).toBe(false);
        expect(latest.current).toBeUndefined();
        expect(latest.isCurrent(second)).toBe(false);
    });

    it(`follows a parent signal, and stops the current attempt on abort and dispose`, () => {
        const latest = new Latest();
        const parent = new AbortController();
        const child = latest.next(parent.signal);
        parent.abort();
        expect(child.aborted).toBe(true);
        expect(latest.isCurrent(child)).toBe(false);

        const next = latest.next();
        latest.dispose();
        expect(next.aborted).toBe(true);
        expect(latest.current).toBeUndefined();
    });
});

describe(`anySignal`, () => {
    it(`aborts with the first of its signals, with that signal's reason, skipping undefined ones`, () => {
        const a = new AbortController();
        const b = new AbortController();
        const linked = anySignal(a.signal, undefined, b.signal);
        b.abort(`because`);
        expect(linked.aborted).toBe(true);
        expect(linked.reason).toBe(`because`);
    });

    it(`hands back a lone signal as itself, and none as one that never aborts`, () => {
        const only = new AbortController().signal;
        expect(anySignal(undefined, only)).toBe(only);
        expect(anySignal().aborted).toBe(false);
    });
});

describe(`retry`, () => {
    it(`tries again after each wait until the task resolves`, async () => {
        const task = jest.fn(async (attempt: number) => {
            if (attempt < 3) {
                throw new Error(`blip ${attempt}`);
            }
            return `ok`;
        });
        const result = retry(task, { attempts: 5, delayMs: (attempt) => attempt * 100 });
        await advanceTimersByTimeAsync(100);
        expect(task).toHaveBeenCalledTimes(2);
        await advanceTimersByTimeAsync(199);
        expect(task).toHaveBeenCalledTimes(2);
        await advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe(`ok`);
        expect(task).toHaveBeenCalledTimes(3);
    });

    it(`rethrows the last failure when the tries run out`, async () => {
        const result = retry(
            async (attempt) => {
                throw new Error(`blip ${attempt}`);
            },
            { attempts: 2, delayMs: () => 10 },
        ).catch((error: unknown) => error);
        await advanceTimersByTimeAsync(10);
        expect(await result).toMatchObject({ message: `blip 2` });
    });

    it(`stops in the wait when the signal aborts, rejecting with the abort's reason as fetch would`, async () => {
        const controller = new AbortController();
        const task = jest.fn(async () => {
            throw new Error(`blip`);
        });
        const result = retry(task, { attempts: Number.POSITIVE_INFINITY, delayMs: () => 5_000, signal: controller.signal }).catch(
            (error: unknown) => error,
        );
        await advanceTimersByTimeAsync(10);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        const error = await result;
        expect(error).toBeInstanceOf(DOMException);
        expect(error).toMatchObject({ name: `AbortError` });
        expect(task).toHaveBeenCalledTimes(1);
    });

    it(`rethrows the try's own failure when the signal aborted during it`, async () => {
        const controller = new AbortController();
        const result = retry(
            async () => {
                controller.abort();
                throw new Error(`cut off`);
            },
            { attempts: 5, delayMs: () => 10, signal: controller.signal },
        );
        await expect(result).rejects.toThrow(`cut off`);
    });

    it(`draws its waits from a backoff ladder`, async () => {
        const backoff = createBackoff({ floorMs: 100, capMs: 1_000, random: () => 1 });
        const task = jest.fn(async (attempt: number) => {
            if (attempt < 3) {
                throw new Error(`blip`);
            }
            return attempt;
        });
        const result = retry(task, { attempts: 3, delayMs: () => backoff.next() });
        await advanceTimersByTimeAsync(200);
        expect(task).toHaveBeenCalledTimes(2);
        await advanceTimersByTimeAsync(400);
        await expect(result).resolves.toBe(3);
    });
});

describe(`pollFor`, () => {
    it(`probes now, then every interval, until a probe answers with a value`, async () => {
        let answers = 0;
        const probe = jest.fn(async () => (++answers >= 3 ? `landed` : undefined));
        const outcome = pollFor(probe, { intervalMs: 50, until: Date.now() + 10_000 });
        expect(probe).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(100);
        await expect(outcome).resolves.toEqual({ kind: `found`, value: `landed` });
    });

    it(`waits an interval before the first probe when asked to`, async () => {
        const probe = jest.fn(async () => `now`);
        const outcome = pollFor(probe, { intervalMs: 3_000, until: Date.now() + 60_000, delayFirst: true });
        await advanceTimersByTimeAsync(2_999);
        expect(probe).not.toHaveBeenCalled();
        await advanceTimersByTimeAsync(1);
        await expect(outcome).resolves.toEqual({ kind: `found`, value: `now` });
    });

    it(`expires at the deadline itself, not on the first tick after it`, async () => {
        const outcome = pollFor(async () => undefined, { intervalMs: 3_000, until: Date.now() + 4_000 });
        let settled = false;
        void outcome.then(() => {
            settled = true;
        });
        await advanceTimersByTimeAsync(3_999);
        expect(settled).toBe(false);
        await advanceTimersByTimeAsync(1);
        await expect(outcome).resolves.toEqual({ kind: `expired` });
    });

    it(`ends the moment its signal aborts, and drops an answer that arrives after`, async () => {
        const controller = new AbortController();
        const waiting = pollFor(async () => undefined, { intervalMs: 3_000, until: Date.now() + 60_000, signal: controller.signal });
        await advanceTimersByTimeAsync(10);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        await expect(waiting).resolves.toEqual({ kind: `aborted` });

        const late = new AbortController();
        const { promise: answer, resolve } = Promise.withResolvers<string>();
        const reading = pollFor(() => answer, { intervalMs: 3_000, until: Date.now() + 60_000, signal: late.signal });
        late.abort();
        resolve(`too late`);
        await expect(reading).resolves.toEqual({ kind: `aborted` });
    });

    it(`polls on through a throwing probe when told to, and propagates one otherwise`, async () => {
        let calls = 0;
        const outcome = pollFor(
            async () => {
                calls += 1;
                if (calls === 1) {
                    throw new Error(`blip`);
                }
                return `ok`;
            },
            { intervalMs: 50, until: Date.now() + 10_000, retryOnError: true },
        );
        await advanceTimersByTimeAsync(50);
        await expect(outcome).resolves.toEqual({ kind: `found`, value: `ok` });
        expect(calls).toBe(2);

        await expect(
            pollFor(
                async () => {
                    throw new Error(`gone`);
                },
                { intervalMs: 50, until: Date.now() + 10_000 },
            ),
        ).rejects.toThrow(`gone`);
    });
});

describe(`withDeadline`, () => {
    it(`answers with the task when it settles in time`, async () => {
        await expect(withDeadline(async () => `ok`, 1_000)).resolves.toBe(`ok`);
    });

    it(`aborts the task's signal at the deadline and rejects with a TimeoutError`, async () => {
        let seen: AbortSignal | undefined;
        const result = withDeadline(
            (signal) => {
                seen = signal;
                return new Promise<never>(() => undefined);
            },
            100,
            { message: `no answer` },
        ).catch((error: unknown) => error);
        await advanceTimersByTimeAsync(99);
        expect(seen?.aborted).toBe(false);
        await advanceTimersByTimeAsync(1);
        const error = await result;
        expect(error).toBeInstanceOf(TimeoutError);
        expect(error).toMatchObject({ message: `no answer` });
        expect(seen?.aborted).toBe(true);
        expect(seen?.reason).toBe(error);
    });

    it(`stops with the caller's abort, even for a task that ignores its signal`, async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const result = withDeadline(
            (signal) => {
                seen = signal;
                return new Promise<never>(() => undefined);
            },
            10_000,
            { signal: controller.signal },
        ).catch((error: unknown) => error);
        controller.abort(`stopped`);
        expect(await result).toBe(`stopped`);
        expect(seen?.aborted).toBe(true);
    });
});

describe(`within`, () => {
    it(`answers with the promise when it settles first, and the fallback once the time passes`, async () => {
        await expect(within(Promise.resolve(`ok`), 1_000, `late`)).resolves.toBe(`ok`);
        const waiting = within(new Promise<never>(() => undefined), 100, `late`);
        await advanceTimersByTimeAsync(100);
        await expect(waiting).resolves.toBe(`late`);
    });

    it(`leaves no timer behind when the promise wins`, async () => {
        const cleared = jest.spyOn(globalThis, `clearTimeout`);
        try {
            await within(Promise.resolve(1), 5_000, 0);
            expect(cleared).toHaveBeenCalledTimes(1);
        } finally {
            cleared.mockRestore();
        }
    });
});

describe(`unlessAborted`, () => {
    it(`answers with the promise when it settles first, and the fallback the moment the signal aborts`, async () => {
        const controller = new AbortController();
        await expect(unlessAborted(Promise.resolve(`ok`), controller.signal, `stopped`)).resolves.toBe(`ok`);
        const waiting = unlessAborted(new Promise<never>(() => undefined), controller.signal, `stopped`);
        controller.abort();
        await expect(waiting).resolves.toBe(`stopped`);
        await expect(unlessAborted(new Promise<never>(() => undefined), controller.signal, `already`)).resolves.toBe(`already`);
    });

    it(`waits on the promise alone with no signal, and passes its rejection on`, async () => {
        await expect(unlessAborted(Promise.resolve(1), undefined, 0)).resolves.toBe(1);
        await expect(unlessAborted(Promise.reject(new Error(`broke`)), new AbortController().signal, 0)).rejects.toThrow(`broke`);
    });

    it(`leaves no listener on the signal however the race ends`, async () => {
        const controller = new AbortController();
        const added = jest.spyOn(controller.signal, `addEventListener`);
        const removed = jest.spyOn(controller.signal, `removeEventListener`);
        for (let read = 0; read < 3; read += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one read after another, as a stream loop does
            await unlessAborted(Promise.resolve(read), controller.signal, -1);
        }
        expect(added).toHaveBeenCalledTimes(3);
        expect(removed).toHaveBeenCalledTimes(3);
    });
});
