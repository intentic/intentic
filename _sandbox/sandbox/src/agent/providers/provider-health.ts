// One backoff clock per provider, shared by every conversation stranded on it, not one per conversation. Waits escalate
// with jitter, debounce to one failure per window, and clear on any successful request from anywhere. In-memory only: a
// restart has no turns in flight to strand.

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

const outages = new Map<string, OutageState>();

// Records a failed turn and returns the current wait state. Debounced: a failure inside an existing wait reports it
// unchanged rather than extending it.
export const recordProviderFailure = (provider: string, now: number = Date.now()): OutageState => {
    const current = outages.get(provider);
    if (current !== undefined && now < current.retryAt) {
        return current;
    }
    const attempt = current?.attempt ?? 0;
    const next: OutageState = { attempt, retryAt: now + waitAfter(attempt) };
    outages.set(provider, next);
    return next;
};

// Clears the outage on any successful request from any turn. Deletes rather than decrements, so the next failure starts
// a fresh streak at the first step.
export const recordProviderSuccess = (provider: string): void => {
    outages.delete(provider);
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
    const attempt = (outages.get(provider)?.attempt ?? 0) + 1;
    outages.set(provider, { attempt, retryAt: now + waitAfter(attempt) });
};
