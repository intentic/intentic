/* HOW LONG TO WAIT BEFORE ASKING A BROKEN PROVIDER AGAIN — one clock per provider, shared by every
 * conversation stranded on it.
 *
 * A model-provider outage is not a per-request accident, and that is the whole design constraint. It is a
 * window of minutes to hours during which SOME requests succeed and most don't, and every refusal still costs a
 * turn's worth of setup for nothing. So the naive shape — each dead conversation retrying on its own timer —
 * is exactly wrong twice over: with eight stranded agents it multiplies the load on a provider that is already
 * failing by eight, and each of those agents learns nothing from the other seven's refusals.
 *
 * Hence one breaker per provider, and three rules that fall out of it:
 *
 * ESCALATING WAITS. Each attempt waits longer than the last (30s → 20m). An outage that clears in a minute
 * costs one retry; one that lasts half an hour costs six, not sixty. The steps carry ±50% jitter so the whole
 * fleet — and, at scale, every sandbox running this daemon — doesn't converge on the same instant and become the
 * thundering herd that keeps a recovering provider down.
 *
 * ONE ATTEMPT PER WINDOW, FLEET-WIDE. The scheduler fires at most one resume per provider per window
 * (turn-resume.ts), and firing it moves the clock. That one turn is the probe: if it survives, the provider is
 * back and every other stranded conversation is released immediately; if it dies, the outage cost exactly one
 * turn to measure. Ten stranded agents and one stranded agent spend the same tokens finding out.
 *
 * ANY WORKING REQUEST IS PROOF OF RECOVERY. The breaker is cleared by evidence, not by its own timer expiring —
 * and the evidence is free, because it is the ordinary traffic the sandbox is already making. A user sending a
 * new message mid-outage, an automation waking, an unrelated agent's turn producing its first token: any of them
 * clears the breaker and releases the whole stranded set at once. This is the "some requests go through"
 * property of a real outage turned from a hazard into the recovery signal, and it means no synthetic health
 * check ever has to be sent.
 *
 * Failures are DEBOUNCED to one per window, so the streak counts intervals of continued failure rather than raw
 * refusals — otherwise a user hammering send during an outage (or a burst of parallel turns dying together)
 * would rocket the backoff to its ceiling in seconds and read as "the daemon gave up immediately".
 *
 * Keyed by provider name ("claude", "codex", "grok", "gemini") — the granularity an outage actually has. A 529
 * is often narrower than that (one model at capacity while its siblings serve fine), which makes this breaker
 * slightly pessimistic for capacity events: an Opus refusal also defers a Sonnet resume. That is the safe
 * direction to be wrong in when the entire purpose is to not spam, and the chat still offers the immediate
 * manual retry for a user who knows better.
 *
 * In memory on purpose, like turn-runs and the pending-resume maps: a daemon restart has no turns in flight to
 * strand, so there is no outage state worth surviving it. */

// Each attempt's wait, indexed by attempts already made. Six steps ≈ 38 minutes of escalating patience before
// the provider is declared properly down and the stranded turns surface as the failures they are. Beyond that
// the tokens are better kept than spent: an outage still running after forty minutes is news the user should
// get, not something to keep quietly re-attempting against for the rest of the afternoon.
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000];

// How many resumes one stranded turn gets before its failure stands. Reported on the wire (events.ts) so the
// notice can promise a bound rather than an open-ended "retrying…".
export const OUTAGE_MAX_ATTEMPTS = BACKOFF_MS.length;

// The wait after `attempt` attempts, at ±50% — long enough to matter, spread enough that N sandboxes recovering
// from the same outage don't all ask at the same instant.
const waitAfter = (attempt: number): number => {
    const step = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0;
    return step / 2 + Math.random() * step;
};

export interface OutageState {
    // Resume attempts already dispatched against this outage, fleet-wide. Also the give-up counter: at
    // OUTAGE_MAX_ATTEMPTS the breaker stops handing out permission.
    readonly attempt: number;
    // When the next attempt may go out (epoch ms).
    readonly retryAt: number;
}

const outages = new Map<string, OutageState>();

/* A turn just died on the provider. Returns the state the client should be told about — the wait it is now in,
 * and how many attempts it has already had.
 *
 * Debounced: a failure that lands while the provider is ALREADY in a wait is the same outage being re-observed
 * (a second agent dying seconds later, a user pressing send into it), not a fresh escalation, so it reports the
 * standing wait instead of extending it. */
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

/* The provider answered — whatever asked it. Called on the first real content of ANY turn (see
 * agent.routes.ts), which is why recovery is usually detected long before the breaker's own clock would have
 * allowed the next probe: ordinary traffic is the health check.
 *
 * Unconditional delete rather than a decrement: a request that went through means the outage is over, and the
 * next one to fail will open a fresh streak at the first backoff step, which is the right place to start over. */
export const recordProviderSuccess = (provider: string): void => {
    outages.delete(provider);
};

// The provider's standing outage, for the client-facing frame and for the scheduler's gate. Absent ⇒ healthy as
// far as anything has observed.
export const providerOutage = (provider: string): OutageState | undefined => outages.get(provider);

/* May a resume go out for this provider right now? False while a wait is still running, and false forever once
 * the attempts are spent — the point past which the honest thing is to leave the failure standing. */
export const outageRetryDue = (provider: string, now: number = Date.now()): boolean => {
    const outage = outages.get(provider);
    if (outage === undefined) {
        return true;
    }
    return outage.attempt < OUTAGE_MAX_ATTEMPTS && now >= outage.retryAt;
};

/* A resume has just been dispatched for this provider: count it, and start the NEXT window immediately rather
 * than waiting to hear how it went. Both halves matter.
 *
 * Counting at dispatch (not at failure) is what makes the one-per-window rule hold across the fleet: the second
 * stranded conversation cannot also fire, because the window it would need has already moved. And starting the
 * window now is what makes a resume that never reports back — killed, aborted, lost with its run — cost one
 * window instead of stalling every other stranded turn behind a probe that will never answer. A resume that
 * SUCCEEDS clears the breaker outright, so nothing is delayed by this in the recovery case. */
export const outageRetryFired = (provider: string, now: number = Date.now()): void => {
    const attempt = (outages.get(provider)?.attempt ?? 0) + 1;
    outages.set(provider, { attempt, retryAt: now + waitAfter(attempt) });
};
