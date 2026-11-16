// A retry loop that fails the same way on every pass (an unreachable forge, a token an organisation refuses, a check that
// times out) used to ask again on every pass and write a line each time it flipped between two reasons: 180 lines of
// `ci: runs backfill failed` and 105 of `claude models: REST catalog refused` in one week (2026-11-16 audit). A tracker
// keeps one key's (one repo's, one account's) failure state and answers two questions:
//
// - May it try now? Each failure in a row doubles the wait, from `floorMs` up to `capMs`, with jitter (createBackoff).
//   A failure marked permanent (no remote to read, a 403 the organisation will keep sending) is not retried at all
//   until the input it failed under changes: `due(key, input)` with a new token or remote clears it at once.
// - Write a line? The first failure of an outage and each reason it has not yet said in that outage; quiet while it keeps
//   failing in ways already said; one "works again" line on the first success after an outage that was said. A failure
//   that comes back within `flapMs` of a recovery continues the earlier outage, so a link that flaps every few minutes
//   writes its reason once rather than once per flap.

import { type Backoff, createBackoff } from "@intentic/base/async";
import { BoundedMap } from "@intentic/base/held";

export interface FailureVerdict {
    // Write the failure line: a reason this outage has not said yet.
    readonly log: boolean;
    // Failures held back in this outage so far.
    readonly repeated: number;
    // When the next attempt is due (epoch ms); undefined for a permanent failure, which waits for its input to change.
    readonly retryAt: number | undefined;
}

export interface FailureRecovery {
    // What it last failed with.
    readonly state: string;
    // Failures held back in the outage.
    readonly repeated: number;
    // When the outage began (epoch ms).
    readonly since: number;
}

export interface FailureTracker {
    // Whether the work under `key` may run now. `input` names what a permanent failure depends on (a token's fingerprint,
    // a remote URL): a different one than it failed under clears the failure and answers true.
    readonly due: (key: string, input?: string) => boolean;
    // The attempt under `key` failed with `state` (a status, an errno, a reason: what tells one failure from another).
    readonly failed: (key: string, state: string, options?: { readonly permanent?: boolean; readonly input?: string }) => FailureVerdict;
    // The attempt went through. Answers the outage it ended when that outage wrote a line, so the caller writes one
    // "works again" line; undefined otherwise.
    readonly succeeded: (key: string) => FailureRecovery | undefined;
    // Drop what is known of `key` (its credentials were replaced, it was disconnected): the next attempt runs at once.
    readonly forget: (key: string) => void;
}

export interface FailureTrackerOptions {
    // Waits between attempts while failing; absent, a failure holds nothing back in time (only a permanent one waits).
    readonly backoff?: { readonly floorMs: number; readonly capMs: number };
    // How soon after a recovery a failure still continues the earlier outage. Default an hour.
    readonly flapMs?: number;
    readonly now?: () => number;
    readonly random?: () => number;
}

interface Entry {
    failing: boolean;
    // Reasons this outage has written.
    said: Set<string>;
    // Whether a line was written since the last "works again".
    unreported: boolean;
    last: string;
    held: number;
    since: number;
    retryAt: number;
    recoveredAt: number | undefined;
    // The input a permanent failure is waiting to see change.
    permanentFor: string | undefined;
    pause: Backoff | undefined;
}

const DEFAULT_FLAP_MS = 60 * 60_000;
// Bounded like the repeat gate: the oldest key is forgotten first, which at worst writes one extra line for it.
const MAX_KEYS = 2000;

export const createFailureTracker = (options: FailureTrackerOptions = {}): FailureTracker => {
    const now = options.now ?? Date.now;
    const flapMs = options.flapMs ?? DEFAULT_FLAP_MS;
    const entries = new BoundedMap<string, Entry>(MAX_KEYS);
    const pauseOf = (): Backoff | undefined =>
        options.backoff === undefined
            ? undefined
            : createBackoff({ ...options.backoff, random: options.random ?? Math.random });

    const due = (key: string, input?: string): boolean => {
        const entry = entries.get(key);
        if (entry === undefined || !entry.failing) {
            return true;
        }
        if (entry.permanentFor !== undefined) {
            if ((input ?? "") === entry.permanentFor) {
                return false;
            }
            // The input changed: whatever failed before says nothing of this one.
            entry.permanentFor = undefined;
            entry.retryAt = 0;
            entry.pause?.reset();
            return true;
        }
        return now() >= entry.retryAt;
    };

    const failed: FailureTracker["failed"] = (key, state, failure = {}) => {
        const at = now();
        let entry = entries.get(key);
        if (entry === undefined) {
            entry = { failing: false, said: new Set(), unreported: false, last: state, held: 0, since: at, retryAt: 0, recoveredAt: undefined, permanentFor: undefined, pause: pauseOf() };
            entries.set(key, entry);
        }
        if (!entry.failing) {
            entry.failing = true;
            // A recovery long enough ago starts a new outage; a flap continues the old one and what it already said.
            if (entry.recoveredAt === undefined || at - entry.recoveredAt >= flapMs) {
                entry.said = new Set();
                entry.held = 0;
                entry.since = at;
            }
        }
        const log = !entry.said.has(state);
        if (log) {
            entry.said.add(state);
            entry.unreported = true;
        } else {
            entry.held += 1;
        }
        entry.last = state;
        if (failure.permanent === true) {
            entry.permanentFor = failure.input ?? "";
            return { log, repeated: entry.held, retryAt: undefined };
        }
        entry.permanentFor = undefined;
        entry.retryAt = entry.pause === undefined ? at : at + entry.pause.next();
        return { log, repeated: entry.held, retryAt: entry.retryAt };
    };

    const succeeded = (key: string): FailureRecovery | undefined => {
        const entry = entries.get(key);
        if (entry === undefined || !entry.failing) {
            return undefined;
        }
        entry.failing = false;
        entry.recoveredAt = now();
        entry.retryAt = 0;
        entry.permanentFor = undefined;
        entry.pause?.reset();
        if (!entry.unreported) {
            return undefined;
        }
        entry.unreported = false;
        return { state: entry.last, repeated: entry.held, since: entry.since };
    };

    return { due, failed, succeeded, forget: (key) => void entries.delete(key) };
};
