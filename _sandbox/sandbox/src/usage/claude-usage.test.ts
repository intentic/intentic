import type { AccountUsage } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { expect, test, vi } from "vitest";
import { type ClaudeStore, displayLabel, type StoredAccount } from "../claude/claude-credentials.js";
import type { AccountUsageStore } from "./account-usage.js";
import { claudeUsageWindows, createClaudeUsageRefresher, readClaudeUsage } from "./claude-usage.js";

/* The Anthropic OAuth usage payload, pinned: a private endpoint rather than a published contract, so what
 * these tests defend is the MAPPING: every pool the account has arrives as its own window, named the way the
 * provider's own usage screen names it, and a shape we don't recognise costs one window rather than the
 * reading. The payloads are captured live rather than invented; the codename keys and the null pools are
 * really there. */

const silent = pino({ level: "silent" });

// One live account's answer, whole (a team plan mid-session: the 5-hour window spent, the weekly pools barely
// touched, and a per-model weekly slice that the flat keys below have no reading for at all).
const LIVE_PAYLOAD = {
    five_hour: { utilization: 100, resets_at: "2026-08-02T17:30:00.254038+00:00", limit_dollars: null, used_dollars: null },
    seven_day: { utilization: 10, resets_at: "2026-08-09T03:00:00.254106+00:00", limit_dollars: null, used_dollars: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    tangelo: null,
    nimbus_quill: null,
    extra_usage: { is_enabled: false, utilization: null, user_disabled: true },
    limits: [
        { kind: "session", group: "session", percent: 100, severity: "critical", resets_at: "2026-08-02T17:30:00.254038+00:00", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 10, severity: "normal", resets_at: "2026-08-09T03:00:00.254106+00:00", scope: null },
        {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 82,
            severity: "warning",
            resets_at: "2026-08-09T03:00:00.254423+00:00",
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
        },
    ],
    spend: { used: { amount_minor: 0, currency: "USD" }, percent: 0, enabled: false },
    member_dashboard_available: false,
};

test("reads every pool the limits list names, including the per-model slice the flat keys cannot report", () => {
    // The scoped pool is the whole reason the list is read: 82% of the Fable allowance is spent while the
    // account's own `seven_day_opus`/`seven_day_sonnet` keys are null and its all-models weekly sits at 10%.
    // Whole SECONDS on our wire (the unit the SDK's own rate_limit frame uses), from ISO-8601 with a
    // sub-second part and an offset.
    expect(claudeUsageWindows(LIVE_PAYLOAD)).toEqual([
        { kind: "five_hour", utilization: 100, resetsAt: 1_785_691_800 },
        { kind: "seven_day", utilization: 10, resetsAt: 1_786_244_400 },
        { kind: "model:Fable", label: "Fable", utilization: 82, resetsAt: 1_786_244_400 },
    ]);
});

test("names a surface-scoped pool by its surface, and an unrecognised one by its own kind", () => {
    expect(
        claudeUsageWindows({
            limits: [
                { kind: "weekly_scoped", percent: 40, resets_at: null, scope: { surface: { display_name: "Cowork" } } },
                {
                    kind: "weekly_scoped",
                    percent: 5,
                    resets_at: null,
                    scope: { model: { display_name: "Opus" }, surface: { display_name: "Cowork" } },
                },
                // A pool this daemon has never heard of still draws: under its raw key, never folded into a
                // neighbour's meter.
                { kind: "monthly_all", percent: 12, resets_at: null, scope: null },
                // No percentage is no reading: skipped, not reported as an empty pool.
                { kind: "weekly_all", percent: null, resets_at: null, scope: null },
            ],
        }),
    ).toEqual([
        { kind: "surface:Cowork", label: "Cowork", utilization: 40 },
        { kind: "model:Opus", label: "Opus · Cowork", utilization: 5 },
        { kind: "claude:monthly_all", utilization: 12 },
    ]);
});

test("falls back to the flat pool keys when the payload carries no list", () => {
    // Every key that carries a reading, not a hand-written five: `seven_day_cowork` arrived without notice and
    // is a real allowance. A null pool is one this plan does not meter: dropped rather than drawn at 0%.
    expect(
        claudeUsageWindows({
            five_hour: { utilization: 12.4, resets_at: "2026-07-27T18:00:00.000Z" },
            seven_day: { utilization: 98, resets_at: "2026-07-29T09:00:00.000Z" },
            seven_day_cowork: { utilization: 3, resets_at: null },
            seven_day_opus: { utilization: null, resets_at: null },
            limits: [],
        }),
    ).toEqual([
        { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000 },
        { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000 },
        { kind: "seven_day_cowork", utilization: 3 },
    ]);
});

test("never counts purchased credits as a plan pool", () => {
    // `extra_usage` carries a utilization like a window, but it is credits bought BEYOND the plan: reading it
    // as a pool would let a spent credit balance decide which account has the least headroom.
    expect(claudeUsageWindows({ extra_usage: { is_enabled: true, utilization: 96 }, five_hour: { utilization: 4, resets_at: null } })).toEqual([
        { kind: "five_hour", utilization: 4 },
    ]);
});

test("an unreadable payload is no reading at all", () => {
    expect(claudeUsageWindows(undefined)).toEqual([]);
    expect(claudeUsageWindows({ limits: "soon" })).toEqual([]);
});

test("a 429 carries the endpoint's own stay-away; without a readable one it is a plain failure", async () => {
    const limited = (async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) })) as unknown as typeof fetch;
    expect(await readClaudeUsage("tok", limited)).toEqual({ windows: [], retryAfterMs: 30_000 });

    const bare = (async () => ({ ok: false, status: 429, headers: new Headers() })) as unknown as typeof fetch;
    expect(await readClaudeUsage("tok", bare)).toEqual({ windows: [] });
});

/* ---- the sweep ---------------------------------------------------------------------------------------------
 * What keeps a row as current as the provider's own screen. Two accounts, one fake endpoint, and no filesystem:
 * the store seams are the whole surface this touches. */

const account = (id: string): StoredAccount => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` });

const memoryStores = (
    accounts: readonly StoredAccount[],
    stored: Record<string, AccountUsage> = {},
): { store: ClaudeStore; usage: AccountUsageStore; recorded: Record<string, AccountUsage> } => {
    const recorded = { ...stored };
    return {
        recorded,
        store: {
            logger: silent,
            read: async (id) => accounts.find((entry) => entry.id === id),
            write: async () => {},
            clear: async () => {},
            list: async () => accounts.map((entry) => ({ id: entry.id, label: displayLabel(entry), connectedAt: entry.connectedAt })),
            withRefreshLock: (_id, act) => act(),
        },
        usage: {
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

const endpoint = (body: unknown, ok = true): typeof fetch =>
    (() => Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

test("sweeps every connected account, and leaves a current reading alone", async () => {
    const fresh: AccountUsage = { windows: [{ kind: "five_hour", utilization: 3 }], measuredAt: Date.now() };
    const { store, usage, recorded } = memoryStores([account("a"), account("b")], { b: fresh });
    await createClaudeUsageRefresher({ store, usage, fetchFn: endpoint(LIVE_PAYLOAD) }).refresh();

    expect(recorded[`a`]?.windows.map((window) => window.kind)).toEqual(["five_hour", "seven_day", "model:Fable"]);
    // Measured a moment ago: another round-trip could not tell us anything the store does not already say.
    expect(recorded[`b`]).toBe(fresh);
});

/* The bound above is right for every read the app takes on its own and wrong for the one a person asks for: they
 * press it precisely because they doubt the number on screen, and "it was current a moment ago" is that number
 * again. Forced, the account is read whatever the store says about it. */
test("a forced sweep re-reads an account the freshness bound would have passed over", async () => {
    const fresh: AccountUsage = { windows: [{ kind: "five_hour", utilization: 3 }], measuredAt: Date.now() };
    const { store, usage, recorded } = memoryStores([account("a")], { a: fresh });
    const refresher = createClaudeUsageRefresher({ store, usage, fetchFn: endpoint(LIVE_PAYLOAD) });

    await refresher.refresh();
    expect(recorded[`a`]).toBe(fresh);

    await refresher.refresh(undefined, true);
    expect(recorded[`a`]?.windows.map((window) => window.kind)).toEqual(["five_hour", "seven_day", "model:Fable"]);
});

// And it cannot be served by the sweep already running: that one chose its accounts before the question was
// asked, so joining it would answer the forced caller with the reading it was sent to go behind.
test("a forced sweep queues behind the one in flight rather than joining it", async () => {
    let answer = (): void => {};
    const held = new Promise<void>((resolve) => {
        answer = resolve;
    });
    let reads = 0;
    const { store, usage } = memoryStores([account("a")]);
    const refresher = createClaudeUsageRefresher({
        store,
        usage,
        fetchFn: (async () => {
            reads += 1;
            await (reads === 1 ? held : Promise.resolve());
            return { ok: true, json: () => Promise.resolve(LIVE_PAYLOAD) };
        }) as unknown as typeof fetch,
    });

    const running = refresher.refresh();
    const forced = refresher.refresh(undefined, true);
    answer();
    await Promise.all([running, forced]);
    expect(reads).toBe(2);
});

test("a refused read leaves the last good snapshot standing", async () => {
    // The failure mode this exists for: an empty window list means "we could not read", never "this account has
    // no limits": overwriting a 98% reading with nothing is how a spent account starts looking healthy.
    const known: AccountUsage = { windows: [{ kind: "seven_day", utilization: 98 }], measuredAt: 0 };
    const { store, usage, recorded } = memoryStores([account("a")], { a: known });
    await createClaudeUsageRefresher({ store, usage, fetchFn: endpoint({}, false) }).refresh();
    expect(recorded[`a`]).toBe(known);
});

/* The failure the freshness bound cannot see: inside the endpoint's stay-away every retry is a guaranteed 429
 * that keeps the window alive, which is how pressing the refresh button made a stale reading STALER. So the
 * stay-away binds the forced read too, and the sweep returns only once the endpoint said it would answer. */
test("a rate-limited account is left alone: even forced, until the endpoint's stay-away has passed", async () => {
    vi.useFakeTimers();
    try {
        let reads = 0;
        const { store, usage, recorded } = memoryStores([account("a")]);
        const refresher = createClaudeUsageRefresher({
            store,
            usage,
            fetchFn: (async () => {
                reads += 1;
                return reads === 1
                    ? { ok: false, status: 429, headers: new Headers({ "retry-after": "600" }) }
                    : { ok: true, json: () => Promise.resolve(LIVE_PAYLOAD) };
            }) as unknown as typeof fetch,
        });

        await refresher.refresh();
        expect(reads).toBe(1);
        expect(recorded).toEqual({});

        await refresher.refresh(undefined, true);
        expect(reads).toBe(1);

        vi.advanceTimersByTime(601_000);
        await refresher.refresh();
        expect(reads).toBe(2);
        expect(recorded[`a`]?.windows).toHaveLength(3);
    } finally {
        vi.useRealTimers();
    }
});

test("the account list is answered on time even when the endpoint is not", async () => {
    let answer = (): void => {};
    const held = new Promise<void>((resolve) => {
        answer = resolve;
    });
    const { store, usage, recorded } = memoryStores([account("a")]);
    const refresher = createClaudeUsageRefresher({
        store,
        usage,
        fetchFn: (async () => {
            await held;
            return { ok: true, json: () => Promise.resolve(LIVE_PAYLOAD) };
        }) as unknown as typeof fetch,
    });

    // The deadline, not the sweep: the connection list must never be held up by a quota endpoint having a slow
    // minute. It gets the rows it has, and the reading it started lands for the next read.
    await refresher.refresh(1);
    expect(recorded).toEqual({});

    answer();
    // A second caller joins the sweep already in flight rather than starting a second one.
    await refresher.refresh();
    expect(recorded[`a`]?.windows).toHaveLength(3);
});
