import type { AccountUsage } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { test, expect, jest } from "bun:test";
import type { AccountUsageStore } from "./account-usage.js";
import { createHeadroomService, FRESH_MS, type HeadroomReading, type HeadroomSource, type HeadroomTarget } from "./headroom.js";
import { memoryUsageParkStore, type UsageParkStore } from "./usage-parks.js";

/* WHEN A READING IS TAKEN, which is the whole of what this service decides: the readers are stood up as counting stubs. */

const silent = pino({ level: "silent" });
const NOW = 1_700_000_000_000;

const memoryStore = (stored: Record<string, AccountUsage> = {}): { store: AccountUsageStore; recorded: Record<string, AccountUsage> } => {
    const recorded = { ...stored };
    return {
        recorded,
        store: {
            read: async () => recorded,
            record: async (id, usage) => {
                recorded[id] = usage;
            },
            clear: async (id) => {
                delete recorded[id];
            },
        },
    };
};

const WINDOWS: HeadroomReading = { windows: [{ kind: "seven_day", utilization: 40, gates: "all" }] };

// A source whose every target counts its reads and answers what it is told to.
const source = (
    targets: readonly { key: string; provider: HeadroomTarget["provider"]; minAgeMs?: number; answer?: () => Promise<HeadroomReading> }[],
) => {
    const reads: Record<string, number> = {};
    return {
        reads,
        source: {
            targets: async () =>
                targets.map((target) => ({
                    key: target.key,
                    provider: target.provider,
                    ...(target.minAgeMs === undefined ? {} : { minAgeMs: target.minAgeMs }),
                    read: async () => {
                        reads[target.key] = (reads[target.key] ?? 0) + 1;
                        return target.answer === undefined ? WINDOWS : target.answer();
                    },
                })),
        } satisfies HeadroomSource,
    };
};

test("reads every target in scope, records what it found, and announces each write", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
        const { store, recorded } = memoryStore();
        const { source: claude, reads } = source([
            { key: "a", provider: "claude" },
            { key: "gemini:g.json", provider: "gemini" },
        ]);
        const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [claude], logger: silent });
        const announced: string[] = [];
        service.onChange((provider, account) => announced.push(`${provider}/${account}`));

        await service.refresh({ scope: { providers: ["claude"] } });
        expect(reads).toEqual({ a: 1 });
        expect(recorded["a"]).toEqual({ windows: [...WINDOWS.windows], measuredAt: NOW });
        expect(announced).toEqual(["claude/a"]);

        await service.refresh();
        // The Claude account was read a moment ago and is left alone; the Google file is due.
        expect(reads).toEqual({ a: 1, "gemini:g.json": 1 });
        expect(announced).toEqual(["claude/a", "gemini/gemini:g.json"]);
    } finally {
        jest.useRealTimers();
    }
});

test("a reading within the freshness bound is not retaken, unless the caller says something happened", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
        const fresh: AccountUsage = { windows: [...WINDOWS.windows], measuredAt: NOW - FRESH_MS / 2 };
        const { store } = memoryStore({ a: fresh });
        const { source: claude, reads } = source([{ key: "a", provider: "claude" }]);
        const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [claude], logger: silent });

        await service.refresh();
        expect(reads).toEqual({});
        // A turn settled, a plan refused: the bound is the caller's to lower.
        await service.refresh({ maxAgeMs: 0 });
        expect(reads).toEqual({ a: 1 });
        // And an account can be named on its own.
        await service.refresh({ scope: { account: "a" }, maxAgeMs: 0 });
        expect(reads).toEqual({ a: 2 });
    } finally {
        jest.useRealTimers();
    }
});

test("two triggers landing together cost one read, and a failed read leaves the last snapshot standing", async () => {
    const known: AccountUsage = { windows: [{ kind: "seven_day", utilization: 98, gates: "all" }], measuredAt: 0 };
    const { store, recorded } = memoryStore({ a: known });
    let answer = (): void => {};
    const held = new Promise<HeadroomReading>((resolve) => {
        answer = () => resolve({ windows: [] });
    });
    const { source: claude, reads } = source([{ key: "a", provider: "claude", answer: () => held }]);
    const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [claude], logger: silent });

    const first = service.refresh({ maxAgeMs: 0 });
    const second = service.refresh({ maxAgeMs: 0 });
    answer();
    await Promise.all([first, second]);
    expect(reads).toEqual({ a: 1 });
    // An empty window list means "could not read", never "this account has no limits".
    expect(recorded["a"]).toBe(known);
});

test("a target's own read budget outranks any freshness a trigger asks for, and only a watched re-measure spends it early", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
        const budget = FRESH_MS * 5;
        const { store } = memoryStore({ budgeted: { windows: [...WINDOWS.windows], measuredAt: NOW - FRESH_MS * 2 } });
        const { source: mixed, reads } = source([
            { key: "budgeted", provider: "claude", minAgeMs: budget },
            { key: "gemini:g.json", provider: "gemini" },
        ]);
        const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [mixed], logger: silent });

        // Both are past the service's own bound; only the one with no budget of its own is read.
        await service.refresh();
        expect(reads).toEqual({ "gemini:g.json": 1 });

        // "Something just happened" is not a person waiting: a refused turn, a settled turn and a warm-up all say zero,
        // they all recur on their own, and together they outrun any endpoint's budget. The budget wins.
        await service.refresh({ maxAgeMs: 0 });
        expect(reads).toEqual({ "gemini:g.json": 2 });

        // Someone pressed something and is watching the number, so it is taken now rather than at the endpoint's
        // convenience. The one caller allowed to spend the budget early, because there is a person per press.
        await service.refresh({ maxAgeMs: 0, watched: true });
        expect(reads).toEqual({ budgeted: 1, "gemini:g.json": 3 });
    } finally {
        jest.useRealTimers();
    }
});

test("honours the endpoint's own stay-away, even for a press someone is watching", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
        const { store } = memoryStore();
        let calls = 0;
        const { source: claude } = source([
            {
                key: "a",
                provider: "claude",
                answer: async () => {
                    calls += 1;
                    return calls === 1 ? { windows: [], retryAfterMs: 600_000 } : WINDOWS;
                },
            },
        ]);
        const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [claude], logger: silent });

        await service.refresh({ maxAgeMs: 0, watched: true });
        await service.refresh({ maxAgeMs: 0, watched: true });
        expect(calls).toBe(1);
        // Reported for as long as it holds, so a screen can say why a re-measure moved nothing.
        expect(service.held()).toEqual([{ provider: "claude", account: "a", until: NOW + 600_000 }]);
        expect(await service.parked("a")).toBe(true);
        jest.setSystemTime(NOW + 600_001);
        expect(service.held()).toEqual([]);
        expect(await service.parked("a")).toBe(false);
        await service.refresh({ maxAgeMs: 0, watched: true });
        expect(calls).toBe(2);
    } finally {
        jest.useRealTimers();
    }
});

// The park is the only thing standing between a rate-limited account and a read it will be refused. Held in memory it
// lasted exactly as long as the process: every restart dropped it, the boot sweep asked the account the provider was
// refusing, and the answer was a stay-away measured from that moment — so restarting pushed the number further out of
// reach than leaving it alone would have.
test("a park outlives the process that earned it, so a restart cannot spend the read it was holding off", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    try {
        const parks: UsageParkStore = memoryUsageParkStore();
        const reader = (): ReturnType<typeof source> =>
            source([{ key: "a", provider: "claude", answer: async () => ({ windows: [], retryAfterMs: 3_600_000 }) }]);

        const before = reader();
        const first = createHeadroomService({ store: memoryStore().store, parks, sources: [before.source], logger: silent });
        await first.refresh({ maxAgeMs: 0, watched: true });
        expect(before.reads).toEqual({ a: 1 });

        // Same box, new process: fresh service, fresh maps, the same park file.
        const after = reader();
        const restarted = createHeadroomService({ store: memoryStore().store, parks, sources: [after.source], logger: silent });
        await restarted.refresh({ maxAgeMs: 0, watched: true });
        expect(after.reads).toEqual({});
        // And the new process can say what it is waiting on, without having earned the refusal itself.
        expect(restarted.held()).toEqual([{ provider: "claude", account: "a", until: NOW + 3_600_000 }]);

        // Past the instant the provider named, the next trigger asks again — a park is a wait, not a write-off.
        jest.setSystemTime(NOW + 3_600_001);
        await restarted.refresh({ maxAgeMs: 0, watched: true });
        expect(after.reads).toEqual({ a: 1 });
    } finally {
        jest.useRealTimers();
    }
});

test("disconnecting an account lifts its park too, so a reconnect is not held off by the credential it replaced", async () => {
    const parks = memoryUsageParkStore();
    const { store } = memoryStore();
    const { source: claude } = source([{ key: "a", provider: "claude", answer: async () => ({ windows: [], retryAfterMs: 600_000 }) }]);
    const service = createHeadroomService({ store, parks, sources: [claude], logger: silent });

    await service.refresh({ maxAgeMs: 0, watched: true });
    expect(await service.parked("a")).toBe(true);
    await service.clear("claude", "a");
    expect(await service.parked("a")).toBe(false);
    expect(await parks.read()).toEqual({});
});

test("answers a caller on time even when the endpoint is not, and the reading still lands", async () => {
    const { store, recorded } = memoryStore();
    let answer = (): void => {};
    const held = new Promise<HeadroomReading>((resolve) => {
        answer = () => resolve(WINDOWS);
    });
    const { source: claude } = source([{ key: "a", provider: "claude", answer: () => held }]);
    const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [claude], logger: silent });

    await service.refresh({ withinMs: 1 });
    expect(recorded).toEqual({});
    answer();
    await service.refresh();
    expect(recorded["a"]?.windows).toEqual([...WINDOWS.windows]);
});

test("a reading handed in from elsewhere is recorded and announced like a swept one, and a clear is announced too", async () => {
    const { store, recorded } = memoryStore();
    const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [], logger: silent });
    const announced: [string, string, AccountUsage | undefined][] = [];
    service.onChange((provider, account, usage) => announced.push([provider, account, usage]));

    const usage: AccountUsage = { windows: [...WINDOWS.windows], measuredAt: 5 };
    await service.record("codex", "codex:one.json", usage);
    await service.clear("codex", "codex:one.json");
    expect(recorded).toEqual({});
    expect(announced).toEqual([
        ["codex", "codex:one.json", usage],
        ["codex", "codex:one.json", undefined],
    ]);
});

// Three different silences: a read that failed, a read that found nothing, and a read that found nothing where nothing
// was ever shown. Only the middle one may retire a snapshot, and only it announces.
test("a read that failed keeps the last snapshot; one that found nothing takes it back", async () => {
    const { store, recorded } = memoryStore();
    let answer: HeadroomReading = WINDOWS;
    const { source: cursor } = source([{ key: "a", provider: "cursor", answer: async () => answer }]);
    const service = createHeadroomService({ store, parks: memoryUsageParkStore(), sources: [cursor], logger: silent });
    const announced: (AccountUsage | undefined)[] = [];
    service.onChange((_provider, _account, usage) => announced.push(usage));

    await service.refresh({ maxAgeMs: 0 });
    expect(recorded["a"]?.windows).toEqual([...WINDOWS.windows]);

    answer = { windows: [] };
    await service.refresh({ maxAgeMs: 0 });
    expect(recorded["a"]?.windows).toEqual([...WINDOWS.windows]);

    answer = { windows: [], empty: true };
    await service.refresh({ maxAgeMs: 0 });
    expect(recorded["a"]).toBeUndefined();
    expect(announced).toEqual([expect.objectContaining({ windows: WINDOWS.windows }), undefined]);

    // Nothing left to take back: a second empty read must not redraw every open window each sweep.
    await service.refresh({ maxAgeMs: 0 });
    expect(announced).toHaveLength(2);
});
