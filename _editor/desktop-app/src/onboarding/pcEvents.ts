import type { LocalPrefetch } from "@intentic/web/local-host";
import type { OnboardingPrefetch, OnboardingSetup, OnboardingSnapshot } from "../desktop";
import { homeOf, scrubReason } from "../device/installTelemetry";

/* WHAT THE FUNNEL HEARS OF THIS PC'S SETUP (2026-10-12), decided here and sent by pc.ts. On 2026-10-12 a reader's first
   launch went quiet for two hours: the download said `failed` and nothing else, the setup said nothing at all, and the
   "resumed after a restart" event could never fire, since what it compared against lived in this module's memory and a
   restart starts the app again. Each event below carries what the Rust side now keeps across launches (onboarding.rs:
   the park a restart leaves, the ledger of a setup running) or says about a failure (its phase, exit and last line). */

/** One event to send: its name and properties, outcomes, ids and timings only. */
export type Tracked = readonly [
    event: `onboarding_prefetch` | `onboarding_setup`,
    properties: Readonly<Record<string, string | number | boolean | undefined>>,
];

// Any path left once the home folder is `~`: a drive path, a share, `~\…`, or an absolute Unix path of two parts or more
// (a URL's own slashes, `npipe:////./pipe/…` and `ghcr.io/intentic/sandbox` are not: each is preceded by a word, a dot,
// a colon or a slash).
const PATHS = /\b[A-Za-z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*|~[\\/][^\s"'<>|]*|(?<![\w.~:/\\-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g;

// A Windows profile folder the text names itself, up to the separator after it. Its name may have a space in it (the
// reader of 2026-10-12 was "prf game"), where scrubReason's own guess stops and would send the rest of the name.
const PROFILE = /\b[A-Za-z]:[\\/]Users[\\/][^\\/"'<>|:*?\r\n]+(?=[\\/])/i;

/**
 * A line a run said, fit to send: the account's home folder and name, any email address and then any path at all taken
 * out (installTelemetry.ts `scrubReason`, with the home read off the run's own log path, else off the text itself).
 */
export const eventReason = (text: string, log?: string): string =>
    scrubReason(text, { home: homeOf(log) ?? PROFILE.exec(text)?.[0] }).replace(PATHS, `<path>`);

const minutesSince = (seconds: number | undefined, now: number): number | undefined =>
    seconds === undefined ? undefined : Math.max(0, Math.round((now / 1000 - seconds) / 60));

/** The download as the Agents page draws it: a failure says why, and whether it is about to try again by itself. */
export const mapPrefetch = (raw: OnboardingPrefetch): LocalPrefetch => {
    if (raw.state !== `failed`) {
        return { state: raw.state, done: raw.done, total: raw.total };
    }
    const reason = raw.failure === undefined ? undefined : eventReason(raw.failure.reason, raw.failure.log);
    return {
        state: raw.state,
        done: raw.done,
        total: raw.total,
        reason: reason === `` ? undefined : reason,
        retrying: raw.retryAt !== undefined,
    };
};

/** What the download's events remember between snapshots: the last one told, and when the first try started. */
export interface PrefetchMemory {
    readonly key: string;
    readonly startedAt: number | undefined;
}

export const NO_PREFETCH: PrefetchMemory = { key: ``, startedAt: undefined };

/** The events for one snapshot, and what to remember for the next. */
export interface Told<Memory> {
    readonly tracked: readonly Tracked[];
    readonly memory: Memory;
}

const prefetchKey = (raw: OnboardingPrefetch): string =>
    [raw.state, raw.done, raw.total, raw.attempt ?? 0, raw.retryAt ?? ``].join(`|`);

/** A try that is running now, after `was`: a retry after a failure, a resume, or the first start. */
const runningAction = (was: OnboardingPrefetch[`state`] | undefined): `retried` | `resumed` | `started` => {
    if (was === `failed`) {
        return `retried`;
    }
    return was === `paused` || was === `metered` || was === `yielded` ? `resumed` : `started`;
};

const failedEvent = (raw: OnboardingPrefetch): Tracked => {
    const failure = raw.failure;
    return [
        `onboarding_prefetch`,
        {
            action: `failed`,
            phase: failure?.phase,
            exitCode: failure?.exitCode,
            reason: failure === undefined ? undefined : eventReason(failure.reason, failure.log),
            done: raw.done,
            total: raw.total,
            attempt: raw.attempt,
            willRetry: raw.retryAt !== undefined,
        },
    ];
};

/** The event for a state the download has just entered, other than running. */
const enteredEvent = (raw: OnboardingPrefetch, startedAt: number | undefined, now: number): Tracked | undefined => {
    switch (raw.state) {
        case `paused`:
        case `metered`:
            return [`onboarding_prefetch`, { action: raw.state }];
        case `yielded`:
            return [`onboarding_prefetch`, { action: `yielded`, done: raw.done, total: raw.total }];
        case `done`: {
            const seconds = startedAt === undefined ? undefined : Math.round((now - startedAt) / 1000);
            return [`onboarding_prefetch`, { action: `done`, seconds, bytes: raw.done }];
        }
        case `skipped`:
            return [`onboarding_prefetch`, { action: `skipped`, why: raw.skipped ?? `unknown` }];
        case `failed`:
            return failedEvent(raw);
        default:
            return undefined;
    }
};

/** The download's events for a snapshot, on each state it enters. `now` is ms since the epoch. */
export const prefetchEvents = (
    raw: OnboardingPrefetch,
    previous: OnboardingPrefetch | undefined,
    memory: PrefetchMemory,
    now: number,
): Told<PrefetchMemory> => {
    const key = prefetchKey(raw);
    const was = previous?.state;
    if (key === memory.key || raw.state === was) {
        return { tracked: [], memory: { ...memory, key } };
    }
    if (raw.state === `running`) {
        const action = runningAction(was);
        const props = action === `retried` ? { action, attempt: raw.attempt } : action === `resumed` ? { action, from: was } : { action };
        return {
            tracked: [[`onboarding_prefetch`, props]],
            memory: { key, startedAt: action === `started` ? now : memory.startedAt },
        };
    }
    const event = enteredEvent(raw, memory.startedAt, now);
    return { tracked: event === undefined ? [] : [event], memory: { ...memory, key } };
};

/** What the setup's events remember between snapshots, for what is told once: a resume, a quiet stretch. */
export interface SetupMemory {
    readonly resumedTold: boolean;
    /** The quiet stretch (its `quietSince`) already told. */
    readonly quietTold: number | undefined;
}

export const NO_SETUP: SetupMemory = { resumedTold: false, quietTold: undefined };

type RunningSetup = Extract<OnboardingSetup, { readonly state: `running` }>;

/** What a running setup tells once: that it is the one a restart was waited for, and that it has gone quiet. */
const runningEvents = (raw: RunningSetup, memory: SetupMemory, now: number): Told<SetupMemory> => {
    const tracked: Tracked[] = [];
    // Told by the app itself (the park a restart left was there at launch), so a restart in between loses nothing.
    const resumed = raw.resumed === true && !memory.resumedTold;
    if (resumed) {
        tracked.push([`onboarding_setup`, { action: `resumedAfterRestart`, minutes: minutesSince(raw.parkedAt, now) }]);
    }
    const quiet = raw.quietSince !== undefined && raw.quietSince !== memory.quietTold;
    if (quiet) {
        tracked.push([
            `onboarding_setup`,
            {
                action: `stalled`,
                step: raw.step === undefined ? undefined : eventReason(raw.step),
                percent: raw.percent,
                minutes: minutesSince(raw.quietSince, now),
            },
        ]);
    }
    return {
        tracked,
        memory: {
            resumedTold: memory.resumedTold || resumed,
            quietTold: quiet ? raw.quietSince : memory.quietTold,
        },
    };
};

/** The event for an outcome the setup has just reached. `minutes` is the check's estimate. */
const outcomeEvent = (raw: OnboardingSetup, previous: OnboardingSetup, minutes: number | undefined): Tracked | undefined => {
    switch (raw.state) {
        case `waiting`:
            if (raw.for === `signOut`) {
                return undefined;
            }
            return [`onboarding_setup`, { action: raw.for === `admin` ? `adminRefused` : `restartAsked` }];
        case `ready`:
            return [`onboarding_setup`, { action: `ready`, minutes }];
        case `failed`: {
            const step = previous.state === `running` ? previous.step : undefined;
            return [
                `onboarding_setup`,
                { action: `failed`, step: step === undefined ? undefined : eventReason(step), reason: eventReason(raw.reason) },
            ];
        }
        default:
            return undefined;
    }
};

/** The PC setup's events for a snapshot. `minutes` is the check's estimate; `now` is ms since the epoch. */
export const setupEvents = (
    raw: OnboardingSetup,
    previous: OnboardingSetup,
    memory: SetupMemory,
    context: { readonly minutes: number | undefined; readonly now: number },
): Told<SetupMemory> => {
    // A run that is over is forgotten: the next one is told afresh.
    const running = raw.state === `running` ? runningEvents(raw, memory, context.now) : { tracked: [], memory: NO_SETUP };
    const outcome = raw.state === previous.state ? undefined : outcomeEvent(raw, previous, context.minutes);
    return { tracked: outcome === undefined ? running.tracked : [...running.tracked, outcome], memory: running.memory };
};

/** A setup the last run of the app left running with no outcome, told once (onboarding.rs reads its ledger at launch). */
export const orphanedEvent = (orphaned: OnboardingSnapshot[`orphaned`], now: number): Tracked | undefined =>
    orphaned === undefined
        ? undefined
        : [`onboarding_setup`, { action: `orphaned`, step: orphaned.step, minutes: minutesSince(orphaned.startedAt, now) }];
