import { describe, expect, it } from "vitest";
import { withConcurrency } from "./concurrency";

// A command whose completion the test controls: `calls` records every input it was actually invoked with,
// which is the whole question these policies answer.
const controllable = () => {
    const calls: string[] = [];
    const pending: { input: string; resolve: (value: string) => void; reject: (reason: unknown) => void }[] = [];
    const run = (input: string): Promise<string> => {
        calls.push(input);
        return new Promise((resolve, reject) => pending.push({ input, resolve, reject }));
    };
    // Settle the oldest outstanding invocation, then let the microtask queue flush so any follow-on run starts.
    const settle = async (value?: string): Promise<void> => {
        const next = pending.shift()!;
        next.resolve(value ?? `${next.input}:done`);
        await Promise.resolve();
        await Promise.resolve();
    };
    const fail = async (reason: unknown): Promise<void> => {
        pending.shift()!.reject(reason);
        await Promise.resolve();
        await Promise.resolve();
    };
    return { calls, run, settle, fail, pending };
};

const byKey = (input: string): string => input.split(`:`)[0]!;

describe(`parallel`, () => {
    it(`returns the command untouched`, () => {
        const { run } = controllable();
        expect(withConcurrency(run, { mode: `parallel` })).toBe(run);
    });
});

describe(`singleFlight`, () => {
    it(`shares one run across concurrent callers of the same key`, async () => {
        const { calls, run, settle } = controllable();
        const load = withConcurrency(run, { mode: `singleFlight`, key: byKey });
        const first = load(`claude`);
        const second = load(`claude`);
        expect(calls).toEqual([`claude`]);
        await settle();
        // The second caller is not merely deduped: it gets the answer, so it can't be left waiting forever.
        expect(await first).toBe(`claude:done`);
        expect(await second).toBe(`claude:done`);
    });

    it(`keeps different keys independent`, async () => {
        const { calls, run, settle } = controllable();
        const load = withConcurrency(run, { mode: `singleFlight`, key: byKey });
        void load(`claude`);
        void load(`codex`);
        expect(calls).toEqual([`claude`, `codex`]);
        await settle();
        await settle();
    });

    it(`runs again once the shared invocation has settled`, async () => {
        const { calls, run, settle } = controllable();
        const load = withConcurrency(run, { mode: `singleFlight`, key: byKey });
        void load(`claude`);
        await settle();
        void load(`claude`);
        expect(calls).toEqual([`claude`, `claude`]);
        await settle();
    });

    it(`does not latch on a failure`, async () => {
        // A dedup that survives its own rejection would leave the picker unable to retry.
        const { calls, run, settle, fail } = controllable();
        const load = withConcurrency(run, { mode: `singleFlight`, key: byKey });
        const first = load(`claude`);
        const caught = first.catch(() => `caught`);
        await fail(new Error(`daemon down`));
        expect(await caught).toBe(`caught`);
        void load(`claude`).catch(() => undefined);
        expect(calls).toEqual([`claude`, `claude`]);
        await settle();
    });
});

describe(`serial`, () => {
    it(`runs every invocation, one at a time, in order`, async () => {
        const { calls, run, settle } = controllable();
        const write = withConcurrency(run, { mode: `serial`, key: byKey });
        void write(`settings:a`);
        void write(`settings:b`);
        void write(`settings:c`);
        // Only the first has started: the point of the policy.
        expect(calls).toEqual([`settings:a`]);
        await settle();
        expect(calls).toEqual([`settings:a`, `settings:b`]);
        await settle();
        expect(calls).toEqual([`settings:a`, `settings:b`, `settings:c`]);
        await settle();
    });

    it(`does not let a failure cancel what is queued behind it`, async () => {
        // Two writes to the same resource are separate commands; the second must still be attempted.
        const { calls, run, settle, fail } = controllable();
        const write = withConcurrency(run, { mode: `serial`, key: byKey });
        const first = write(`settings:a`);
        const caught = first.catch(() => `caught`);
        const second = write(`settings:b`);
        await fail(new Error(`refused`));
        expect(await caught).toBe(`caught`);
        expect(calls).toEqual([`settings:a`, `settings:b`]);
        await settle();
        expect(await second).toBe(`settings:b:done`);
    });

    it(`interleaves different keys freely`, async () => {
        const { calls, run, settle } = controllable();
        const write = withConcurrency(run, { mode: `serial`, key: byKey });
        void write(`a:1`);
        void write(`b:1`);
        expect(calls).toEqual([`a:1`, `b:1`]);
        await settle();
        await settle();
    });
});

describe(`latest`, () => {
    it(`collapses everything queued behind the running invocation to the newest input`, async () => {
        const { calls, run, settle } = controllable();
        const search = withConcurrency(run, { mode: `latest`, key: byKey });
        void search(`q:fo`);
        void search(`q:foo`);
        void search(`q:foob`);
        expect(calls).toEqual([`q:fo`]);
        await settle();
        // `q:foo` is never run: by the time a slot opened, it was already stale.
        expect(calls).toEqual([`q:fo`, `q:foob`]);
        await settle();
    });

    it(`settles a superseded caller with the newer run's result`, async () => {
        // The alternative (leaving the dropped caller's promise hanging) silently wedges any `await` on it.
        const { run, settle } = controllable();
        const search = withConcurrency(run, { mode: `latest`, key: byKey });
        void search(`q:fo`);
        const superseded = search(`q:foo`);
        const winner = search(`q:foob`);
        await settle();
        await settle();
        expect(await superseded).toBe(`q:foob:done`);
        expect(await winner).toBe(`q:foob:done`);
    });

    it(`propagates a failure to everyone waiting on that run`, async () => {
        const { run, settle, fail } = controllable();
        const search = withConcurrency(run, { mode: `latest`, key: byKey });
        void search(`q:a`).catch(() => undefined);
        const queued = search(`q:b`).catch((error: Error) => error.message);
        await settle();
        await fail(new Error(`search failed`));
        expect(await queued).toBe(`search failed`);
    });

    it(`starts immediately when nothing is running`, async () => {
        const { calls, run, settle } = controllable();
        const search = withConcurrency(run, { mode: `latest`, key: byKey });
        void search(`q:a`);
        await settle();
        void search(`q:b`);
        expect(calls).toEqual([`q:a`, `q:b`]);
        await settle();
    });
});
