import type { ProviderDegraded } from "@intentic/sandbox-contract/schemas/providers/capacity";
import { nudgeCapacity } from "../../usage/serviceability/capacity-watch.js";

// One backoff clock per provider, shared by every conversation stranded on it, not one per conversation. Waits escalate
// with jitter, debounce to one failure per window, and clear on any successful request from anywhere. In-memory only: a
// restart loses the clock, its spent attempts and its wait, and the next failure starts it over. The turns stranded on
// it are not re-run after a restart: each stands on its conversation's record as an outage ending, for a press.

// Every change of a provider's outage is said to its capacity (capacity-watch.ts nudgeCapacity), so each window shows
// the provider failing, and when it is tried again, as the turns stranded on it see it.

/* A THROTTLE OPENS THE SAME BACKOFF, AND SAYS SO. A rate limit nothing showed to be a spent allowance is waited out here
   like an outage (agent/run/frames/limits/limit-cause.ts), and its capacity says which it is: `throttle` where the failure that
   opened the current wait was one, `outage` otherwise (ProviderDegraded.cause). The wait opened decides it: a failure
   inside a running wait is the same episode and changes nothing, a resume that goes out keeps it, and the next wait the
   provider earns is named by the failure that opens it. Kept in memory with the clock it rides on, so a restart forgets
   it the same way. (2026-11-19) Rejected: a second clock for throttles. The stranded turns, the resume pass and the
   attempt budget are the same whichever it is; only what the windows say differs. */
export type OutageCause = ProviderDegraded["cause"];

// Escalating wait per attempt, ms; six steps top out near 38 minutes before the outage is surfaced.
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000];

// Resumes allowed before a stranded turn's failure stands; reported on the wire for a bounded notice.
export const OUTAGE_MAX_ATTEMPTS = BACKOFF_MS.length;

// Wait after `attempt` failures, jittered +/-50% so sandboxes recovering from the same outage don't ask at once.
const waitAfter = (attempt: number): number => {
    const step = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0;
    return step / 2 + Math.random() * step;
};

export interface OutageState {
    // Resume attempts already dispatched, fleet-wide; also the give-up counter against OUTAGE_MAX_ATTEMPTS.
    readonly attempt: number;
    // When the next attempt may go out (epoch ms).
    readonly retryAt: number;
}

// One provider's wait as the breaker keeps it: the state every reader shares, and what opened it.
interface Backoff extends OutageState {
    readonly cause: OutageCause;
}

const outages = new Map<string, Backoff>();

// Records a failed turn and returns the current wait state. Debounced: a failure inside an existing wait reports it
// unchanged rather than extending it, and leaves the cause the wait was opened with.
export const recordProviderFailure = (provider: string, now: number = Date.now(), cause: OutageCause = "outage"): OutageState => {
    const current = outages.get(provider);
    if (current !== undefined && now < current.retryAt) {
        return current;
    }
    const attempt = current?.attempt ?? 0;
    const next: Backoff = { attempt, retryAt: now + waitAfter(attempt), cause };
    outages.set(provider, next);
    nudgeCapacity(provider);
    return next;
};

// Clears the outage on any successful request from any turn. Deletes rather than decrements, so the next failure starts
// a fresh streak at the first step.
export const recordProviderSuccess = (provider: string): void => {
    if (outages.delete(provider)) {
        nudgeCapacity(provider);
    }
};

// The provider's standing outage, for the client frame and the scheduler's gate; absent means healthy.
export const providerOutage = (provider: string): OutageState | undefined => outages.get(provider);

// Whether a resume may go out now: false during an active wait, and false forever once attempts are spent.
export const outageRetryDue = (provider: string, now: number = Date.now()): boolean => {
    const outage = outages.get(provider);
    if (outage === undefined) {
        return true;
    }
    return outage.attempt < OUTAGE_MAX_ATTEMPTS && now >= outage.retryAt;
};

// Marks a resume as dispatched: counts the attempt and starts the next window immediately, so a resume that never
// reports back costs one window, not a stall.
export const outageRetryFired = (provider: string, now: number = Date.now()): void => {
    const current = outages.get(provider);
    const attempt = (current?.attempt ?? 0) + 1;
    outages.set(provider, { attempt, retryAt: now + waitAfter(attempt), cause: current?.cause ?? "outage" });
    nudgeCapacity(provider);
};

/** The provider's outage or throttle as its capacity says it (ProviderDegraded); absent while it is healthy. */
export const providerDegraded = (provider: string): ProviderDegraded | undefined => {
    const outage = outages.get(provider);
    return outage === undefined ? undefined : { cause: outage.cause, retryAt: outage.retryAt, attempt: outage.attempt };
};
