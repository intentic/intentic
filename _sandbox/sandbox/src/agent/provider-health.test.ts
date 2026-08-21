import { expect, test } from "vitest";
import {
    OUTAGE_MAX_ATTEMPTS,
    outageRetryDue,
    outageRetryFired,
    providerOutage,
    recordProviderFailure,
    recordProviderSuccess,
} from "./provider-health.js";

/* The breaker is module state keyed by provider name, so every test invents its own provider rather than
 * resetting a shared one: the same convention turn-resume.integration.test.ts uses for conversation ids. */

const NOW = 1_000_000;

test("the first failure opens a short wait, and the wait grows with every attempt made", () => {
    const first = recordProviderFailure("ph-grow", NOW);
    expect(first.attempt).toBe(0);
    // Step one is 30s at ±50%: never instant (which would be a hot loop), never wildly past the step either.
    expect(first.retryAt).toBeGreaterThanOrEqual(NOW + 15_000);
    expect(first.retryAt).toBeLessThanOrEqual(NOW + 45_000);

    // An attempt goes out at the instant it came due, and dies. The next wait is drawn from the next step up,
    // so a provider that stays down is asked less and less often instead of on a fixed cadence. Driven off the
    // breaker's own clock rather than a hard-coded elapsed time: the jitter is the point, so a test that
    // assumed an exact instant would be testing something this module deliberately doesn't promise.
    outageRetryFired("ph-grow", NOW);
    const due = providerOutage("ph-grow")?.retryAt ?? NOW;
    expect(due).toBeGreaterThanOrEqual(NOW + 30_000);
    expect(due).toBeLessThanOrEqual(NOW + 90_000);

    const second = recordProviderFailure("ph-grow", due);
    expect(second.attempt).toBe(1);
    expect(second.retryAt).toBeGreaterThanOrEqual(due + 30_000);
    expect(second.retryAt).toBeLessThanOrEqual(due + 90_000);
});

test("failures inside a running wait are the same outage, not an escalation", () => {
    const opened = recordProviderFailure("ph-debounce", NOW);
    // Eight more agents dying seconds later, and a user hammering send into the outage: must not multiply the
    // backoff. Each reports the standing wait untouched.
    for (let i = 1; i <= 8; i += 1) {
        expect(recordProviderFailure("ph-debounce", NOW + i * 100)).toEqual(opened);
    }
    expect(providerOutage("ph-debounce")).toEqual(opened);
});

test("nothing may go out while the wait runs; exactly one attempt is released when it elapses", () => {
    const { retryAt } = recordProviderFailure("ph-window", NOW);
    expect(outageRetryDue("ph-window", retryAt - 1)).toBe(false);
    expect(outageRetryDue("ph-window", retryAt)).toBe(true);

    // Firing moves the clock at dispatch time, so the second stranded conversation cannot also fire in this
    // pass: one probe per window, however many turns are waiting on it.
    outageRetryFired("ph-window", retryAt);
    expect(outageRetryDue("ph-window", retryAt)).toBe(false);
});

test("a working request clears the outage outright and releases everything at once", () => {
    recordProviderFailure("ph-recover", NOW);
    expect(outageRetryDue("ph-recover", NOW)).toBe(false);
    // The evidence is ordinary traffic: any turn's first content, so recovery is normally seen long before the
    // breaker's own clock would have permitted the next probe.
    recordProviderSuccess("ph-recover");
    expect(providerOutage("ph-recover")).toBeUndefined();
    expect(outageRetryDue("ph-recover", NOW)).toBe(true);

    // And the next outage starts over at the first step rather than resuming the old streak.
    expect(recordProviderFailure("ph-recover", NOW).attempt).toBe(0);
});

test("the attempts are finite: a provider down for the long haul stops being asked", () => {
    let now = NOW;
    for (let i = 0; i < OUTAGE_MAX_ATTEMPTS; i += 1) {
        now = providerOutage("ph-spent")?.retryAt ?? now;
        expect(outageRetryDue("ph-spent", now)).toBe(true);
        outageRetryFired("ph-spent", now);
        recordProviderFailure("ph-spent", now + 1);
    }
    expect(providerOutage("ph-spent")?.attempt).toBe(OUTAGE_MAX_ATTEMPTS);
    // Past the budget the wait no longer matters: the failure stands rather than being re-attempted forever.
    expect(outageRetryDue("ph-spent", now + 10 * 60 * 60_000)).toBe(false);
});

test("an unobserved provider is healthy: the gate opens before anything has failed", () => {
    expect(providerOutage("ph-fresh")).toBeUndefined();
    expect(outageRetryDue("ph-fresh", NOW)).toBe(true);
});

test("providers are independent: one vendor's outage never gates another's", () => {
    recordProviderFailure("ph-a", NOW);
    expect(outageRetryDue("ph-a", NOW)).toBe(false);
    expect(outageRetryDue("ph-b", NOW)).toBe(true);
});
