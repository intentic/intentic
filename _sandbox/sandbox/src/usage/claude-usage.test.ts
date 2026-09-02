import { pino } from "pino";
import { expect, test } from "vitest";
import { type ClaudeStore, displayLabel, type StoredAccount } from "../claude/claude-credentials.js";
import { claudeHeadroomSource, claudeUsageWindows, readClaudeUsage } from "./claude-usage.js";

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
        { kind: "five_hour", utilization: 100, resetsAt: 1_785_691_800, gates: "all" },
        { kind: "seven_day", utilization: 10, resetsAt: 1_786_244_400, gates: "all" },
        // …and gated to the tier the plan named it by, so it binds a Fable turn and leaves a Haiku call alone.
        { kind: "model:Fable", label: "Fable", utilization: 82, resetsAt: 1_786_244_400, gates: { models: ["Fable"] } },
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
        // A surface alone is another product's allowance on this plan: shown, never binding a turn here.
        { kind: "surface:Cowork", label: "Cowork", utilization: 40, gates: "none" },
        { kind: "model:Opus", label: "Opus · Cowork", utilization: 5, gates: { models: ["Opus"] } },
        // Unscoped, so the plan's own, and it gates everything.
        { kind: "claude:monthly_all", utilization: 12, gates: "all" },
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
        { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000, gates: "all" },
        { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000, gates: "all" },
        // A flat key this sandbox's turns do not spend: shown, never binding.
        { kind: "seven_day_cowork", utilization: 3, gates: "none" },
    ]);
});

test("never counts purchased credits as a plan pool", () => {
    // `extra_usage` carries a utilization like a window, but it is credits bought BEYOND the plan: reading it
    // as a pool would let a spent credit balance decide which account has the least headroom.
    expect(claudeUsageWindows({ extra_usage: { is_enabled: true, utilization: 96 }, five_hour: { utilization: 4, resets_at: null } })).toEqual([
        { kind: "five_hour", utilization: 4, gates: "all" },
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

/* ---- the headroom source ---------------------------------------------------------------------------------
 * The Claude half of the headroom service: one target per connected account that can still read, each on its
 * own token. The service owns when they are asked (usage/headroom.ts has its own suite); what is pinned here
 * is which accounts become targets and what a target's read answers. */

const account = (id: string, over: Partial<StoredAccount> = {}): StoredAccount => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}`, ...over });

const memoryStore = (accounts: readonly StoredAccount[]): ClaudeStore => ({
    logger: silent,
    read: async (id) => accounts.find((entry) => entry.id === id),
    write: async () => {},
    clear: async () => {},
    list: async () =>
        accounts.map((entry) => ({
            id: entry.id,
            label: displayLabel(entry),
            connectedAt: entry.connectedAt,
            // The store's own rule (toAccount): a revoked credential lists as one to reconnect.
            ...(entry.revokedAt === undefined ? {} : { needsReauth: true }),
        })),
    withRefreshLock: (_id, act) => act(),
});

const endpoint = (body: unknown, ok = true): typeof fetch =>
    (() => Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

test("publishes one target per account that can read, keyed by the account, and skips a revoked credential", async () => {
    const source = claudeHeadroomSource(memoryStore([account("a"), account("revoked", { revokedAt: 1 }), account("b")]), endpoint(LIVE_PAYLOAD));
    const targets = await source.targets();
    expect(targets.map((target) => [target.provider, target.key])).toEqual([
        ["claude", "a"],
        ["claude", "b"],
    ]);
    expect((await targets[0]!.read()).windows.map((window) => window.kind)).toEqual(["five_hour", "seven_day", "model:Fable"]);
});

test("a refused read answers no windows, never an empty measurement", async () => {
    // The failure mode this exists for: an empty window list means "we could not read", never "this account
    // has no limits", and the service leaves the last good snapshot standing on it.
    const source = claudeHeadroomSource(memoryStore([account("a")]), endpoint({}, false));
    const [target] = await source.targets();
    expect(await target!.read()).toEqual({ windows: [] });
});
