import type { UsageWindow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { test, expect } from "bun:test";
import type { ClaudeStore, StoredAccount } from "../runtimes/claude/claude-credentials.js";
import { claimLimitReset, type LimitResetDeps, readLimitReset } from "./claude-limit-reset.js";
import { claudeUsageWindows, RATE_LIMIT_PARK_MS } from "./claude-usage.js";

// Once-a-week session-limit reset, over its two seams: the stored credential and the provider (stubbed as fetch).
// Shapes are transcribed from live responses, not invented.

const ACCOUNT: StoredAccount = { id: "a", connectedAt: 1, accessToken: "tok" };

// Enough of the store for `ensureFreshToken`: a stored account whose token has no expiry is usable as it
// stands, so nothing here ever reaches the refresh path (which is claude-credentials' own subject).
const store = (account: StoredAccount | undefined = ACCOUNT): ClaudeStore => unstubbed<ClaudeStore>("claudeStore", { read: async () => account });

// The probe shares the headroom service's park for this endpoint, and files the reading its answer carries. Recorded
// here rather than stubbed away, since both are the point of routing it through the service at all.
interface Gate {
    readonly parks: { provider: string; account: string; forMs: number }[];
    readonly filed: { account: string; windows: readonly UsageWindow[] }[];
}
const gate = (claudeStore: ClaudeStore, seen: Gate = { parks: [], filed: [] }, parkedAccounts: ReadonlySet<string> = new Set()): LimitResetDeps => ({
    store: claudeStore,
    headroom: {
        parked: async (account) => parkedAccounts.has(account),
        park: async (provider, account, forMs) => {
            seen.parks.push({ provider, account, forMs });
        },
        record: async (_provider, account, usage) => {
            seen.filed.push({ account, windows: usage.windows });
        },
    },
});

interface Call {
    readonly url: string;
    readonly method: string;
    readonly userAgent: string | null;
    readonly body: string | undefined;
}

// A fetch that answers each URL from a table and records what it was asked, so the User-Agent, which is the
// one header the provider's answer actually turns on, is assertable.
const provider = (answers: Record<string, { status?: number; body?: unknown }>, calls: Call[] = []): { fetchFn: typeof fetch; calls: Call[] } => ({
    calls,
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? "GET", userAgent: headers.get("User-Agent"), body: init?.body as string | undefined });
        const answer = Object.entries(answers).find(([key]) => url.includes(key))?.[1] ?? { status: 404 };
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
    }) as unknown as typeof fetch,
});

const eligible = {
    eligible: true,
    available: true,
    in_experiment: true,
    arm: "reset",
    ineligible_reason: null,
    weekly_resets_at: "2026-09-08T00:00:00Z",
};

test("an eligible account is offered, and the probe identifies itself as the CLI the allowance is spent by", async () => {
    const { fetchFn, calls } = provider({ "/api/oauth/usage": { body: { juniper_tide: eligible } } });

    expect(await readLimitReset(gate(store()), "a", fetchFn)).toEqual({ available: true, weeklyResetsAt: Date.parse("2026-09-08T00:00:00Z") / 1000 });
    // Without the CLI User-Agent header, the provider answers ineligible_reason "surface" for every account.
    expect(calls[0]?.userAgent).toMatch(/^claude-cli\//);
    // Only asked at the wall, the one moment the claim is true.
    expect(calls[0]?.url).toContain("at_wall=1");
});

test("general eligibility does not offer a reset outside the provider's reset rollout", async () => {
    // Live affected-account response: the usage endpoint offered general eligibility, but claiming answered
    // ineligible. Claude Code itself requires the reset arm before showing this offer.
    for (const enrollment of [{ in_experiment: false, arm: null }, { in_experiment: true, arm: "control" }, {}]) {
        const { fetchFn } = provider({
            "/api/oauth/usage": { body: { juniper_tide: { eligible: true, available: true, ...enrollment } } },
        });
        expect(await readLimitReset(gate(store()), "a", fetchFn)).toEqual({ available: false });
    }
});

test("every way of having nothing to offer answers the same way, so no button is ever drawn from a guess", async () => {
    // Organisation-managed plan is outside the programme entirely, told so with a null block.
    const outside = provider({ "/api/oauth/usage": { body: { juniper_tide: null } } });
    expect(await readLimitReset(gate(store()), "a", outside.fetchFn)).toEqual({ available: false });

    // Eligible but this week's grant is spent; the provider's own reason is carried through.
    const spent = provider({
        "/api/oauth/usage": {
            body: {
                juniper_tide: { eligible: true, available: false, ineligible_reason: "already_used", next_available_at: "2026-09-08T00:00:00Z" },
            },
        },
    });
    expect(await readLimitReset(gate(store()), "a", spent.fetchFn)).toEqual({
        available: false,
        reason: "already_used",
        nextAvailableAt: Date.parse("2026-09-08T00:00:00Z") / 1000,
    });

    // A missing credential is a known absence. A refused probe is not an answer about eligibility.
    const refused = provider({ "/api/oauth/usage": { status: 500 } });
    expect(await readLimitReset(gate(store()), "a", refused.fetchFn)).toBeUndefined();
    expect(await readLimitReset(gate(unstubbed<ClaudeStore>("missing account", { read: async () => undefined })), "a", refused.fetchFn)).toEqual({
        available: false,
    });
});

test("a busy or malformed status endpoint leaves eligibility unanswered and a later probe can recover", async () => {
    for (const answer of [{ status: 429 }, { status: 503 }, { body: {} }, { body: null }, { body: { juniper_tide: {} } }]) {
        expect(await readLimitReset(gate(store()), "a", provider({ "/api/oauth/usage": answer }).fetchFn)).toBeUndefined();
    }
    const available = provider({ "/api/oauth/usage": { body: { juniper_tide: eligible } } });
    expect(await readLimitReset(gate(store()), "a", available.fetchFn)).toMatchObject({ available: true });
});

test("claiming addresses the account's organisation and hands back the provider's own word for what it did", async () => {
    const { fetchFn, calls } = provider({
        "/api/oauth/profile": { body: { organization: { uuid: "org-1", name: "Personal" } } },
        "/reset_rate_limits": { body: { result: "reset", next_available_at: "2026-09-12T00:00:00Z" } },
    });

    expect(await claimLimitReset(store(), "a", fetchFn)).toEqual({ result: "reset", nextAvailableAt: Date.parse("2026-09-12T00:00:00Z") / 1000 });
    // uuid lives only on the profile; the stored credential keeps the organisation's name for display.
    const claim = calls.at(-1);
    expect(claim?.url).toContain("/api/organizations/org-1/reset_rate_limits");
    expect(claim?.method).toBe("POST");
    expect(claim?.body).toBe(JSON.stringify({ program: "juniper_tide" }));
});

test("a claim that changed nothing says which kind of nothing, and never reports a reset it did not get", async () => {
    const profile = { "/api/oauth/profile": { body: { organization: { uuid: "org-1" } } } };

    // Provider's own refusal words ride out intact; different reasons matter to the person who pressed the button.
    for (const result of ["already_used", "not_limited", "ineligible"] as const) {
        const { fetchFn } = provider({ ...profile, "/reset_rate_limits": { body: { result } } });
        expect(await claimLimitReset(store(), "a", fetchFn)).toEqual({ result });
    }

    // An unrecognised result reads as unavailable, the reading that neither claims a reset nor blames the account.
    const strange = provider({ ...profile, "/reset_rate_limits": { body: { result: "quantum" } } });
    expect(await claimLimitReset(store(), "a", strange.fetchFn)).toMatchObject({ result: "unavailable" });

    // 429 is the endpoint asking for a moment, not the grant being gone, so it stays retryable.
    const busy = provider({ ...profile, "/reset_rate_limits": { status: 429 } });
    expect(await claimLimitReset(store(), "a", busy.fetchFn)).toMatchObject({ result: "unavailable" });

    // A profile naming no organisation has nothing to address; it errors rather than posting nowhere.
    const nameless = provider({ "/api/oauth/profile": { body: {} } });
    expect(await claimLimitReset(store(), "a", nameless.fetchFn)).toMatchObject({ result: "error" });
    expect(nameless.calls.some((call) => call.url.includes("reset_rate_limits"))).toBe(false);
});

// This probe reads the same URL the headroom sweep does. Two readers of one budgeted endpoint have to share one
// stay-away, or the budget the number on screen depends on is spent by the caller that is not being bounded.

test("a probe never lands on an endpoint the provider is already holding off, and arms that hold from its own 429", async () => {
    const held = provider({ "/api/oauth/usage": { body: { juniper_tide: eligible } } });
    expect(await readLimitReset(gate(store(), undefined, new Set(["a"])), "a", held.fetchFn)).toBeUndefined();
    // Not asked at all: a probe spends this endpoint's budget exactly like a sweep's read does.
    expect(held.calls).toEqual([]);

    const seen: Gate = { parks: [], filed: [] };
    const busy = provider({ "/api/oauth/usage": { status: 429 } });
    expect(await readLimitReset(gate(store(), seen), "a", busy.fetchFn)).toBeUndefined();
    // No retry-after on this answer, so the endpoint's own park stands in — the same one readClaudeUsage falls back to.
    expect(seen.parks).toEqual([{ provider: "claude", account: "a", forMs: RATE_LIMIT_PARK_MS }]);
});

test("the usage payload a probe already paid for is filed as a reading rather than discarded", async () => {
    const seen: Gate = { parks: [], filed: [] };
    const { fetchFn } = provider({
        "/api/oauth/usage": {
            body: { juniper_tide: eligible, five_hour: { utilization: 100, resets_at: "2026-09-08T00:00:00Z" }, seven_day: { utilization: 4 } },
        },
    });
    expect(await readLimitReset(gate(store(), seen), "a", fetchFn)).toMatchObject({ available: true });
    // For an account at the wall this is the freshest reading anything will get: the sweep is the caller being held off.
    expect(seen.filed).toEqual([
        {
            account: "a",
            windows: claudeUsageWindows({ five_hour: { utilization: 100, resets_at: "2026-09-08T00:00:00Z" }, seven_day: { utilization: 4 } }),
        },
    ]);
});
