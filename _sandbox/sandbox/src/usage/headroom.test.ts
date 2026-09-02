import type { AccountUsage } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { expect, test, vi } from "vitest";
import type { AccountUsageStore } from "./account-usage.js";
import { createHeadroomService, FRESH_MS, type HeadroomReading, type HeadroomSource, type HeadroomTarget } from "./headroom.js";

/* WHEN A READING IS TAKEN, which is the whole of what this service decides: the readers are stood up as
 * counting stubs, and what is pinned is the freshness bound, the scope, the coalescing, the stay-away, and
 * the announcement every write makes. */

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
const source = (targets: readonly { key: string; provider: HeadroomTarget["provider"]; answer?: () => Promise<HeadroomReading> }[]) => {
    const reads: Record<string, number> = {};
    return {
        reads,
        source: {
            targets: async () =>
                targets.map((target) => ({
                    key: target.key,
                    provider: target.provider,
                    read: async () => {
                        reads[target.key] = (reads[target.key] ?? 0) + 1;
                        return target.answer === undefined ? WINDOWS : target.answer();
                    },
                })),
        } satisfies HeadroomSource,
    };
};

test("reads every target in scope, records what it found, and announces each write", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
        const { store, recorded } = memoryStore();
        const { source: claude, reads } = source([
            { key: "a", provider: "claude" },
            { key: "gemini:g.json", provider: "gemini" },
        ]);
        const service = createHeadroomService({ store, sources: [claude], logger: silent });
        const announced: string[] = [];
        service.onChange((provider, account) => announced.push(`${provider}/${account}`));

        await service.refresh({ scope: { providers: ["claude"] } });
        expect(reads).toEqual({ a: 1 });
        expect(recorded["a"]).toEqual({ windows: WINDOWS.windows, measuredAt: NOW });
        expect(announced).toEqual(["claude/a"]);

        await service.refresh();
        // The Claude account was read a moment ago and is left alone; the Google file is due.
        expect(reads).toEqual({ a: 1, "gemini:g.json": 1 });
        expect(announced).toEqual(["claude/a", "gemini/gemini:g.json"]);
    } finally {
        vi.useRealTimers();
    }
});

test("a reading within the freshness bound is not retaken, unless the caller says something happened", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
        const fresh: AccountUsage = { windows: [...WINDOWS.windows], measuredAt: NOW - FRESH_MS / 2 };
        const { store } = memoryStore({ a: fresh });
        const { source: claude, reads } = source([{ key: "a", provider: "claude" }]);
        const service = createHeadroomService({ store, sources: [claude], logger: silent });

        await service.refresh();
        expect(reads).toEqual({});
        // A turn settled, a plan refused: the bound is the caller's to lower.
        await service.refresh({ maxAgeMs: 0 });
        expect(reads).toEqual({ a: 1 });
        // And an account can be named on its own.
        await service.refresh({ scope: { account: "a" }, maxAgeMs: 0 });
        expect(reads).toEqual({ a: 2 });
    } finally {
        vi.useRealTimers();
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
    const service = createHeadroomService({ store, sources: [claude], logger: silent });

    const first = service.refresh({ maxAgeMs: 0 });
    const second = service.refresh({ maxAgeMs: 0 });
    answer();
    await Promise.all([first, second]);
    expect(reads).toEqual({ a: 1 });
    // An empty window list means "could not read", never "this account has no limits".
    expect(recorded["a"]).toBe(known);
});

test("honours the endpoint's own stay-away, even for a caller that says something happened", async () => {
    vi.useFakeTimers({ now: NOW });
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
        const service = createHeadroomService({ store, sources: [claude], logger: silent });

        await service.refresh({ maxAgeMs: 0 });
        await service.refresh({ maxAgeMs: 0 });
        expect(calls).toBe(1);
        vi.setSystemTime(NOW + 600_001);
        await service.refresh({ maxAgeMs: 0 });
        expect(calls).toBe(2);
    } finally {
        vi.useRealTimers();
    }
});

test("answers a caller on time even when the endpoint is not, and the reading still lands", async () => {
    const { store, recorded } = memoryStore();
    let answer = (): void => {};
    const held = new Promise<HeadroomReading>((resolve) => {
        answer = () => resolve(WINDOWS);
    });
    const { source: claude } = source([{ key: "a", provider: "claude", answer: () => held }]);
    const service = createHeadroomService({ store, sources: [claude], logger: silent });

    await service.refresh({ withinMs: 1 });
    expect(recorded).toEqual({});
    answer();
    await service.refresh();
    expect(recorded["a"]?.windows).toEqual(WINDOWS.windows);
});

test("a reading handed in from elsewhere is recorded and announced like a swept one, and a clear is announced too", async () => {
    const { store, recorded } = memoryStore();
    const service = createHeadroomService({ store, sources: [], logger: silent });
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
