import { expect, test } from "vitest";
import { authFileCooling, codexUsageFromPayload, codexUsageFromRateLimits, geminiUsageFromPayload, kimiUsageFromPayload } from "./translator-usage.js";

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
    expect(authFileCooling({ name: "a.json", unavailable: true, status_message: "quota exceeded", next_retry_after: "2027-01-15T08:10:00Z" })).toEqual({
        until: Date.parse("2027-01-15T08:10:00Z") / 1000,
        reason: "quota exceeded",
    });
    expect(authFileCooling({ name: "a.json", disabled: true })).toEqual({ reason: "disabled in the translator" });
    expect(authFileCooling({ name: "a.json", unavailable: false, status: "active" })).toBeUndefined();
    expect(authFileCooling({ name: "a.json" })).toBeUndefined();
});
