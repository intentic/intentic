import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { ClaudeStore, StoredAccount } from "../runtimes/claude/claude-credentials.js";
import { claimLimitReset, readLimitReset } from "./claude-limit-reset.js";

/* The once-a-week session-limit reset, over the two seams it has: the stored credential and the provider.
 *
 * The provider is stubbed as a fetch, which is the whole of what this module talks to, and every test here is
 * about a shape the real endpoints answer with, transcribed from live responses rather than invented: an
 * account inside the programme gets an eligibility block, one outside it gets `null`, and the claim answers a
 * word out of a fixed set. */

const ACCOUNT: StoredAccount = { id: "a", connectedAt: 1, accessToken: "tok" };

// Enough of the store for `ensureFreshToken`: a stored account whose token has no expiry is usable as it
// stands, so nothing here ever reaches the refresh path (which is claude-credentials' own subject).
const store = (account: StoredAccount | undefined = ACCOUNT): ClaudeStore => unstubbed<ClaudeStore>("claudeStore", { read: async () => account });

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

    expect(await readLimitReset(store(), "a", fetchFn)).toEqual({ available: true, weeklyResetsAt: Date.parse("2026-09-08T00:00:00Z") / 1000 });
    // The header is the whole reason this feature was previously believed unavailable: without it the provider
    // answers `ineligible_reason: "surface"` for every account on every plan. It is not decoration and it is
    // not optional, so it is pinned by a test rather than left to whoever edits the headers next.
    expect(calls[0]?.userAgent).toMatch(/^claude-cli\//);
    // Only asked at the wall, because that is the only moment the claim is true.
    expect(calls[0]?.url).toContain("at_wall=1");
});

test("general eligibility does not offer a reset outside the provider's reset rollout", async () => {
    // Live affected-account response: the usage endpoint offered general eligibility, but claiming answered
    // ineligible. Claude Code itself requires the reset arm before showing this offer.
    for (const enrollment of [{ in_experiment: false, arm: null }, { in_experiment: true, arm: "control" }, {}]) {
        const { fetchFn } = provider({
            "/api/oauth/usage": { body: { juniper_tide: { eligible: true, available: true, ...enrollment } } },
        });
        expect(await readLimitReset(store(), "a", fetchFn)).toEqual({ available: false });
    }
});

test("every way of having nothing to offer answers the same way, so no button is ever drawn from a guess", async () => {
    // An organisation-managed plan is outside the programme entirely and is told so with a null block.
    const outside = provider({ "/api/oauth/usage": { body: { juniper_tide: null } } });
    expect(await readLimitReset(store(), "a", outside.fetchFn)).toEqual({ available: false });

    // Eligible but this week's grant is spent: the reason is carried through, since somebody asking why the
    // button is missing is owed the provider's own word for it.
    const spent = provider({
        "/api/oauth/usage": {
            body: {
                juniper_tide: { eligible: true, available: false, ineligible_reason: "already_used", next_available_at: "2026-09-08T00:00:00Z" },
            },
        },
    });
    expect(await readLimitReset(store(), "a", spent.fetchFn)).toEqual({
        available: false,
        reason: "already_used",
        nextAvailableAt: Date.parse("2026-09-08T00:00:00Z") / 1000,
    });

    // A missing credential is a known absence. A refused probe is not an answer about eligibility.
    const refused = provider({ "/api/oauth/usage": { status: 500 } });
    expect(await readLimitReset(store(), "a", refused.fetchFn)).toBeUndefined();
    expect(await readLimitReset(unstubbed<ClaudeStore>("missing account", { read: async () => undefined }), "a", refused.fetchFn)).toEqual({
        available: false,
    });
});

test("a busy or malformed status endpoint leaves eligibility unanswered and a later probe can recover", async () => {
    for (const answer of [{ status: 429 }, { status: 503 }, { body: {} }, { body: null }, { body: { juniper_tide: {} } }]) {
        expect(await readLimitReset(store(), "a", provider({ "/api/oauth/usage": answer }).fetchFn)).toBeUndefined();
    }
    const available = provider({ "/api/oauth/usage": { body: { juniper_tide: eligible } } });
    expect(await readLimitReset(store(), "a", available.fetchFn)).toMatchObject({ available: true });
});

test("claiming addresses the account's organisation and hands back the provider's own word for what it did", async () => {
    const { fetchFn, calls } = provider({
        "/api/oauth/profile": { body: { organization: { uuid: "org-1", name: "Personal" } } },
        "/reset_rate_limits": { body: { result: "reset", next_available_at: "2026-09-12T00:00:00Z" } },
    });

    expect(await claimLimitReset(store(), "a", fetchFn)).toEqual({ result: "reset", nextAvailableAt: Date.parse("2026-09-12T00:00:00Z") / 1000 });
    // The uuid is on the profile and nowhere else: the stored credential keeps the organisation's NAME, which
    // is what the account row shows and is not addressable.
    const claim = calls.at(-1);
    expect(claim?.url).toContain("/api/organizations/org-1/reset_rate_limits");
    expect(claim?.method).toBe("POST");
    expect(claim?.body).toBe(JSON.stringify({ program: "juniper_tide" }));
});

test("a claim that changed nothing says which kind of nothing, and never reports a reset it did not get", async () => {
    const profile = { "/api/oauth/profile": { body: { organization: { uuid: "org-1" } } } };

    // The provider's own refusals ride out intact: "come back next week" and "the window already reopened" are
    // different answers to the person who just pressed the button.
    for (const result of ["already_used", "not_limited", "ineligible"]) {
        const { fetchFn } = provider({ ...profile, "/reset_rate_limits": { body: { result } } });
        expect(await claimLimitReset(store(), "a", fetchFn)).toEqual({ result });
    }

    // A word we don't know reads as `unavailable`: the one safe reading, since it neither claims a reset nor
    // blames the account.
    const strange = provider({ ...profile, "/reset_rate_limits": { body: { result: "quantum" } } });
    expect(await claimLimitReset(store(), "a", strange.fetchFn)).toMatchObject({ result: "unavailable" });

    // 429 is the endpoint asking for a moment, not the week's grant being gone, so it stays retryable.
    const busy = provider({ ...profile, "/reset_rate_limits": { status: 429 } });
    expect(await claimLimitReset(store(), "a", busy.fetchFn)).toMatchObject({ result: "unavailable" });

    // A profile that names no organisation leaves nothing to address, and says so rather than posting nowhere.
    const nameless = provider({ "/api/oauth/profile": { body: {} } });
    expect(await claimLimitReset(store(), "a", nameless.fetchFn)).toMatchObject({ result: "error" });
    expect(nameless.calls.some((call) => call.url.includes("reset_rate_limits"))).toBe(false);
});
