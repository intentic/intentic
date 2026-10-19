import {
    authFileCooling,
    codexUsageFromPayload,
    codexUsageFromRateLimits,
    fetchTranslatorUsage,
    geminiUsageFromPayload,
    kimiUsageFromPayload,
} from "./translator-usage.js";

// Pins the mapping into AccountUsage: every named pool becomes its own window, utilization is always utilization, never
// remaining, and a missing field costs only that window.

test("maps every ChatGPT limit window to utilized percentages and reset instants", () => {
    const measuredAt = 1_800_000_000_000;
    const usage = codexUsageFromPayload(
        {
            rate_limit: {
                primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_after_seconds: 300 },
                secondary_window: { used_percent: "82", limit_window_seconds: 604_800, reset_at: 1_800_604_800 },
            },
            code_review_rate_limit: {
                primary_window: { used_percent: 7, limit_window_seconds: 18_000 },
            },
            additional_rate_limits: [
                {
                    limit_name: "GPT-5 Codex Spark",
                    rate_limit: { primary_window: { used_percent: 11, limit_window_seconds: 604_800 } },
                },
            ],
        },
        measuredAt,
    );

    expect(usage).toEqual({
        measuredAt,
        windows: [
            { kind: "five_hour", utilization: 23, resetsAt: 1_800_000_300, gates: "all" },
            { kind: "seven_day", utilization: 82, resetsAt: 1_800_604_800, gates: "all" },
            // Named features no chat turn spends: shown, never binding.
            { kind: "code-review:five_hour", label: "Code review · 5-hour", utilization: 7, gates: "none" },
            { kind: "additional-1:seven_day", label: "GPT-5 Codex Spark · Weekly", utilization: 11, gates: "none" },
        ],
    });
});

// A spent plan returns one window, `limit_reached`, and a null secondary; the null must be skipped, not read as a
// second pool at 0%.
test("reads a fully spent ChatGPT plan from its single live window", () => {
    const measuredAt = 1_800_000_000_000;
    expect(
        codexUsageFromPayload(
            {
                rate_limit: {
                    allowed: false,
                    limit_reached: true,
                    primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_786_019_642 },
                    secondary_window: null,
                },
                code_review_rate_limit: null,
                additional_rate_limits: null,
            },
            measuredAt,
        ),
    ).toEqual({ measuredAt, windows: [{ kind: "seven_day", utilization: 100, resetsAt: 1_786_019_642, gates: "all" }] });
});

// The whole reason a 2% ring sat over a refused turn: a plan pool is gated `all` and says nothing about entitlement.
// ChatGPT publishes the missing fact as `model_usage`, and each unavailable model has to become a pool of its own,
// scoped to that model, or the account's plan pool answers for it.
test("files a model the plan will not serve as its own spent pool, gating that model alone", () => {
    const measuredAt = 1_800_000_000_000;
    const usage = codexUsageFromPayload(
        {
            rate_limit: {
                allowed: false,
                limit_reached: true,
                primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 1_789_916_642 },
                secondary_window: { used_percent: 44, limit_window_seconds: 604_800, reset_at: 1_790_419_137 },
            },
            model_usage: {
                "gpt-6-astra": { available: false, available_at: "2026-09-20T15:04:03.154758Z", credits_would_enable: true },
                "gpt-5.6-terra": { available: true },
            },
        },
        measuredAt,
    );

    expect(usage).toEqual({
        measuredAt,
        windows: [
            { kind: "five_hour", utilization: 100, resetsAt: 1_789_916_642, gates: "all" },
            { kind: "seven_day", utilization: 44, resetsAt: 1_790_419_137, gates: "all" },
            // Not `model:`: this is an entitlement, not a metered slice of the plan, and must not be labelled as one.
            {
                kind: "entitlement:gpt-6-astra",
                label: "gpt-6-astra",
                utilization: 100,
                resetsAt: Math.floor(Date.parse("2026-09-20T15:04:03.154758Z") / 1000),
                gates: { models: ["gpt-6-astra"] },
            },
        ],
    });
});

// A plan that publishes only a long allowance (ChatGPT free: one 30-day window, no per-model list) must not have an
// entitlement invented for it. Silence about a model is not a reading that it is unavailable.
test("files nothing per model when the plan publishes no per-model availability", () => {
    const measuredAt = 1_800_000_000_000;
    expect(
        codexUsageFromPayload(
            {
                plan_type: "free",
                rate_limit: { allowed: true, primary_window: { used_percent: 2, limit_window_seconds: 2_592_000 }, secondary_window: null },
                model_usage: {},
            },
            measuredAt,
        ),
    ).toEqual({
        measuredAt,
        windows: [{ kind: "monthly", label: "Monthly · all models", utilization: 2, gates: "all" }],
    });
});

test("inverts Google's remaining fractions and preserves each named quota bucket", () => {
    const measuredAt = 1_800_000_000_000;
    const usage = geminiUsageFromPayload(
        {
            groups: [
                {
                    displayName: "Gemini Pro",
                    buckets: [
                        {
                            bucketId: "pro-five-hour",
                            displayName: "5-hour",
                            remainingFraction: 0.12,
                            resetTime: "2027-01-15T08:00:00Z",
                        },
                        { bucket_id: "pro-weekly", display_name: "Weekly", remaining_fraction: "75%" },
                    ],
                },
            ],
        },
        measuredAt,
    );

    expect(usage).toEqual({
        measuredAt,
        windows: [
            {
                kind: "google:pro-five-hour",
                label: "Gemini Pro · 5-hour",
                utilization: 88,
                resetsAt: Date.parse("2027-01-15T08:00:00Z") / 1000,
                gates: { models: ["gemini"] },
            },
            { kind: "google:pro-weekly", label: "Gemini Pro · Weekly", utilization: 25, gates: { models: ["gemini"] } },
        ],
    });
});

// `remainingFraction: 0` is a real reading (fully exhausted), not missing data; guard against `??`/`||` discarding it.
test("treats an exhausted Google bucket as fully utilized rather than unmeasured", () => {
    expect(
        geminiUsageFromPayload({
            groups: [
                { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0 }] },
                { displayName: "Third Party", buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0 }] },
            ],
        })?.windows,
    ).toEqual([
        // Each group gates its own family.
        { kind: "google:gemini-weekly", label: "Gemini Models · Weekly Limit", utilization: 100, gates: { models: ["gemini"] } },
        { kind: "google:3p-weekly", label: "Third Party · Weekly Limit", utilization: 100, gates: { models: ["claude", "gpt"] } },
    ]);
});

// Kimi sends used/limit as decimal-string counts, not percentages, so the mapping divides; the throttle (100/100) sits
// inside the plan pool (40/100).
test("maps a Kimi Code reading to its plan pool and its throttle", () => {
    const measuredAt = 1_800_000_000_000;
    expect(
        kimiUsageFromPayload(
            {
                limited: true,
                usage: { limit: "100", used: "40", remaining: "60", resetTime: "2026-08-07T07:16:02.549855Z" },
                limits: [
                    {
                        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
                        detail: { limit: "100", used: "100", resetTime: "2026-07-31T22:16:02.549855Z" },
                    },
                ],
            },
            measuredAt,
        ),
    ).toEqual({
        measuredAt,
        windows: [
            { kind: "seven_day", utilization: 40, resetsAt: Math.floor(Date.parse("2026-08-07T07:16:02.549855Z") / 1000), gates: "all" },
            { kind: "five_hour", utilization: 100, resetsAt: Math.floor(Date.parse("2026-07-31T22:16:02.549855Z") / 1000), gates: "all" },
        ],
    });
});

// An unnamed throttle length keeps its own namespaced kind and states its length rather than being dropped.
test("names a Kimi throttle this vocabulary has no shared kind for", () => {
    expect(
        kimiUsageFromPayload({
            limits: [{ window: { duration: 12, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "50", used: "10" } }],
        })?.windows,
    ).toEqual([{ kind: "kimi:43200s", label: "12-hour window", utilization: 20, gates: "all" }]);
});

// No usable window returns undefined, not zero; a Kimi pool with a zero limit is unmetered, not exhausted.
test("returns nothing when a payload carries no usable window", () => {
    expect(codexUsageFromPayload({ rate_limit: null })).toBeUndefined();
    expect(geminiUsageFromPayload({ groups: [] })).toBeUndefined();
    expect(geminiUsageFromPayload("not json")).toBeUndefined();
    expect(kimiUsageFromPayload({ usage: { limit: "0", used: "0" }, limits: [] })).toBeUndefined();
    expect(kimiUsageFromPayload("not json")).toBeUndefined();
});

// App-server pushes the same two windows as camelCase `primary`/`secondary` in minutes, mapped onto the same kinds a
// pulled reading uses.
test("maps an app-server rate-limit snapshot onto the same windows as the pulled reading", () => {
    const measuredAt = 1_800_000_000_000;
    expect(
        codexUsageFromRateLimits(
            {
                limitId: "codex",
                primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_900 },
                secondary: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
            },
            measuredAt,
        ),
    ).toEqual({
        measuredAt,
        windows: [
            { kind: "five_hour", utilization: 37, resetsAt: 1_800_000_900, gates: "all" },
            { kind: "seven_day", utilization: 91, resetsAt: 1_800_604_800, gates: "all" },
        ],
    });
    expect(codexUsageFromRateLimits({ primary: null, secondary: null })).toBeUndefined();
    expect(codexUsageFromRateLimits("not a snapshot")).toBeUndefined();
});

// The proxy's own bench of a credential, off its /auth-files listing: the one fact fresher than any reading.
test("reads the translator's bench of a credential, and nothing for one it is routing to", () => {
    expect(
        authFileCooling({ name: "a.json", unavailable: true, status_message: "quota exceeded", next_retry_after: "2027-01-15T08:10:00Z" }),
    ).toEqual({
        until: Date.parse("2027-01-15T08:10:00Z") / 1000,
        reason: "quota exceeded",
    });
    expect(authFileCooling({ name: "a.json", disabled: true })).toEqual({ reason: "disabled in the translator" });
    expect(authFileCooling({ name: "a.json", unavailable: false, status: "active" })).toBeUndefined();
    expect(authFileCooling({ name: "a.json" })).toBeUndefined();
});

// What the proxy actually stamps on a rate-limited Google credential: the upstream 429 body, pretty-printed, ~700
// characters of it. The row that prints the reason gets the body's own sentence, never the body, and never a countdown
// that is stale the moment it is stored (the bench's `until` says when).
test("lifts the sentence out of a pasted upstream body, never the body itself", () => {
    const body = JSON.stringify({ error: { code: 429, message: "Individual quota reached. Please try again later. Resets in 70h35m49s." } }, undefined, 2);
    expect(authFileCooling({ name: "a.json", unavailable: true, status_message: body, next_retry_after: "2027-01-15T08:10:00Z" })).toEqual({
        until: Date.parse("2027-01-15T08:10:00Z") / 1000,
        reason: "Individual quota reached. Please try again later.",
    });
    // A body with no sentence in it leaves nothing, and the operator's switch still says what it is.
    const wordless = JSON.stringify({ error: { code: 500 } });
    expect(authFileCooling({ name: "a.json", disabled: true, status_message: wordless })).toEqual({ reason: "disabled in the translator" });
    expect(authFileCooling({ name: "a.json", unavailable: true, status_message: " quota exceeded \nstack trace" })).toEqual({
        reason: "quota exceeded",
    });
});

// Google's 403 for an account it wants its owner to confirm, as the proxy stamps it: the page to do that on rides in
// the ErrorInfo. The proxy's retry instant is dropped, since its retry fails until somebody verifies.
test("a credential Google wants verified carries the page to verify it on, and no wait", () => {
    const body = JSON.stringify(
        {
            error: {
                code: 403,
                message: "Verify your account to continue.",
                status: "PERMISSION_DENIED",
                details: [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "VALIDATION_REQUIRED",
                        metadata: { validation_url: "https://accounts.google.com/signin/continue?sarp=1" },
                    },
                ],
            },
        },
        undefined,
        2,
    );
    expect(authFileCooling({ name: "a.json", unavailable: true, status_message: body, next_retry_after: "2027-01-15T08:10:00Z" })).toEqual({
        reason: "Verify your account to continue.",
        verify: "https://accounts.google.com/signin/continue?sarp=1",
    });
});

// Google's answer for an account it wants verified, as the proxy's api-call relays it: the call itself succeeds, the
// upstream status and body ride inside. Folded into "no reading" it froze four accounts' numbers with nothing said.
// Each Google method gets its own answer (the method is the tail of the proxied URL), and every one asked is recorded.
const proxiedBy = (answer: (method: string) => { status: number; body: unknown }, asked: string[] = []): typeof fetch =>
    (async (_url: string, init?: RequestInit) => {
        const method = /"url":"[^"]*:(\w+)"/.exec(String(init?.body))?.[1] ?? "";
        asked.push(method);
        const { status, body } = answer(method);
        return Response.json({ status_code: status, body: JSON.stringify(body) });
    }) as unknown as typeof fetch;
const proxied = (statusCode: number, body: unknown): typeof fetch => proxiedBy(() => ({ status: statusCode, body }));

const GOOGLE_FILE = { name: "antigravity-a@example.com.json", provider: "antigravity", auth_index: "idx", project_id: "p-1" };

test("a refused quota read comes back with the provider's own sentence, not as nothing", async () => {
    const verify = {
        error: {
            code: 403,
            message: "Verify your account to continue.",
            status: "PERMISSION_DENIED",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "VALIDATION_REQUIRED" }],
        },
    };
    const read = await fetchTranslatorUsage({ fetchFn: proxied(403, verify), managementUrl: "http://proxy", managementToken: "t", provider: "gemini", file: GOOGLE_FILE });
    expect(read).toEqual({ failure: "Verify your account to continue." });

    // No sentence to lift, and a pasted body is never one: the status stands in.
    const bare = await fetchTranslatorUsage({ fetchFn: proxied(500, { error: { message: "x".repeat(400) } }), managementUrl: "http://proxy", managementToken: "t", provider: "gemini", file: GOOGLE_FILE });
    expect(bare).toEqual({ failure: "HTTP 500" });

    const ok = await fetchTranslatorUsage({
        fetchFn: proxied(200, { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.75 }] }] }),
        managementUrl: "http://proxy",
        managementToken: "t",
        provider: "gemini",
        file: GOOGLE_FILE,
    });
    expect(ok).toEqual({ usage: expect.objectContaining({ windows: [expect.objectContaining({ kind: "google:gemini-weekly", utilization: 25 })] }) });
});

const proxiedGoogle = (answers: Record<string, { status: number; body: unknown }>, asked: string[]): typeof fetch =>
    proxiedBy((method) => answers[method] ?? { status: 404, body: { error: { message: "no such method" } } }, asked);

// Google's summary as it answered on 2026-10-19: the Claude and GPT group alone, spent, and no Gemini group at all.
const SUMMARY_WITHOUT_GEMINI = {
    groups: [
        {
            displayName: "Claude and GPT models",
            buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", resetTime: "2026-10-24T12:03:31Z", remainingFraction: 0 }],
        },
    ],
};
const PER_MODEL = {
    models: {
        "gemini-3.8-flash-tiered": { quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-24T19:26:43Z" } },
        "claude-opus-4-6-thinking": { quotaInfo: { resetTime: "2026-10-24T12:03:31Z" } },
    },
};

// Read off the summary alone, every Google account showed one spent pool, which read as the whole account spent while
// every Gemini model still had room.
test("a family the quota summary leaves out is read off the per-model view, and the summary's own pools stand", async () => {
    const asked: string[] = [];
    const read = await fetchTranslatorUsage({
        fetchFn: proxiedGoogle({ retrieveUserQuotaSummary: { status: 200, body: SUMMARY_WITHOUT_GEMINI }, fetchAvailableModels: { status: 200, body: PER_MODEL } }, asked),
        managementUrl: "http://proxy",
        managementToken: "t",
        provider: "gemini",
        file: GOOGLE_FILE,
    });
    expect(asked).toEqual(["retrieveUserQuotaSummary", "fetchAvailableModels"]);
    expect("usage" in read ? read.usage.windows : read).toEqual([
        expect.objectContaining({ kind: "google:3p-weekly", utilization: 100, gates: { models: ["claude", "gpt"] } }),
        expect.objectContaining({ kind: "google:models:gemini", label: "Gemini models", utilization: 75, gates: { models: ["gemini"] } }),
    ]);
});

test("a summary naming every family is the whole reading, and a failed per-model read leaves it as it was", async () => {
    const both = {
        groups: [
            { displayName: "Gemini models", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.5 }] },
            ...SUMMARY_WITHOUT_GEMINI.groups,
        ],
    };
    const asked: string[] = [];
    const full = await fetchTranslatorUsage({
        fetchFn: proxiedGoogle({ retrieveUserQuotaSummary: { status: 200, body: both } }, asked),
        managementUrl: "http://proxy",
        managementToken: "t",
        provider: "gemini",
        file: GOOGLE_FILE,
    });
    expect(asked).toEqual(["retrieveUserQuotaSummary"]);
    expect("usage" in full ? full.usage.windows.map((window) => window.kind) : full).toEqual(["google:gemini-weekly", "google:3p-weekly"]);

    const partial = await fetchTranslatorUsage({
        fetchFn: proxiedGoogle({ retrieveUserQuotaSummary: { status: 200, body: SUMMARY_WITHOUT_GEMINI } }, []),
        managementUrl: "http://proxy",
        managementToken: "t",
        provider: "gemini",
        file: GOOGLE_FILE,
    });
    expect("usage" in partial ? partial.usage.windows.map((window) => window.kind) : partial).toEqual(["google:3p-weekly"]);
});

// A summary that answers nothing usable no longer leaves the account unread when the per-model view answers.
test("the per-model view alone is a reading when the summary refuses", async () => {
    const read = await fetchTranslatorUsage({
        fetchFn: proxiedGoogle({ fetchAvailableModels: { status: 200, body: PER_MODEL } }, []),
        managementUrl: "http://proxy",
        managementToken: "t",
        provider: "gemini",
        file: GOOGLE_FILE,
    });
    expect("usage" in read ? read.usage.windows.map((window) => [window.kind, window.utilization]) : read).toEqual([
        ["google:models:gemini", 75],
        ["google:models:3p", 100],
    ]);
});
