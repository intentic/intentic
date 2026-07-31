import { expect, test } from "vitest";
import { codexUsageFromPayload, geminiUsageFromPayload } from "./translator-usage.js";

// The two upstream payload shapes, pinned. These are private endpoints rather than published contracts, so what
// these tests really defend is the mapping INTO AccountUsage: every pool the provider names arrives as its own
// window, utilization is always utilization (never "remaining"), and a missing field costs that one window
// rather than the whole reading.

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
            { kind: "five_hour", utilization: 23, resetsAt: 1_800_000_300 },
            { kind: "seven_day", utilization: 82, resetsAt: 1_800_604_800 },
            { kind: "code-review:five_hour", label: "Code review · 5-hour", utilization: 7 },
            { kind: "additional-1:seven_day", label: "GPT-5 Codex Spark · Weekly", utilization: 11 },
        ],
    });
});

// The shape a spent team plan really returns (captured from the live endpoint): one window, `limit_reached`,
// and a null secondary. The null is the point — it must be skipped, not read as a second pool at 0%.
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
    ).toEqual({ measuredAt, windows: [{ kind: "seven_day", utilization: 100, resetsAt: 1_786_019_642 }] });
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
            },
            { kind: "google:pro-weekly", label: "Gemini Pro · Weekly", utilization: 25 },
        ],
    });
});

/* A bucket at `remainingFraction: 0` is the whole reason this feature exists — it is what an exhausted free
 * Google account reports, and reading that 0 as "no data" instead of "100% used" is precisely how a spent
 * account keeps rendering as a healthy green dot. Guarded because `0` is falsy and every `??`/`||` in the parse
 * path is one keystroke away from discarding it. */
test("treats an exhausted Google bucket as fully utilized rather than unmeasured", () => {
    expect(
        geminiUsageFromPayload({
            groups: [
                { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0 }] },
                { displayName: "Third Party", buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0 }] },
            ],
        })?.windows,
    ).toEqual([
        { kind: "google:gemini-weekly", label: "Gemini Models · Weekly Limit", utilization: 100 },
        { kind: "google:3p-weekly", label: "Third Party · Weekly Limit", utilization: 100 },
    ]);
});

// No quota in the payload is not a reading of zero — the account must come back unmeasured so the row keeps its
// dot instead of claiming headroom nobody measured.
test("returns nothing when a payload carries no usable window", () => {
    expect(codexUsageFromPayload({ rate_limit: null })).toBeUndefined();
    expect(geminiUsageFromPayload({ groups: [] })).toBeUndefined();
    expect(geminiUsageFromPayload("not json")).toBeUndefined();
});
