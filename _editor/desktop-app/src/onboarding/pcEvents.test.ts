import type { OnboardingPrefetch, OnboardingSetup } from "../desktop";
import {
    eventReason,
    mapPrefetch,
    NO_PREFETCH,
    NO_SETUP,
    orphanedEvent,
    prefetchEvents,
    setupEvents,
    type PrefetchMemory,
    type SetupMemory,
    type Tracked,
} from "./pcEvents";

// What the funnel hears of this PC's own setup and the download started at first launch. On 2026-10-12 a reader's
// download said `failed` and nothing more, his setup said nothing for two hours, and a resume after a restart could never
// be told: each case below is one of those, told now.

const NOW = 1_791_000_000_000;
const LOG = `C:\\Users\\prf game\\.intentic\\logs\\desktop-pc-image-20261012-110745.log`;

const prefetch = (state: OnboardingPrefetch[`state`], more: Partial<OnboardingPrefetch> = {}): OnboardingPrefetch => ({
    state,
    done: 0,
    total: 0,
    ...more,
});

/** Feed snapshots in order, as pc.ts does, and collect what was told. */
const playPrefetch = (snapshots: readonly OnboardingPrefetch[], at: (index: number) => number = () => NOW): Tracked[] => {
    let memory: PrefetchMemory = NO_PREFETCH;
    let previous: OnboardingPrefetch | undefined;
    const told: Tracked[] = [];
    snapshots.forEach((raw, index) => {
        const step = prefetchEvents(raw, previous, memory, at(index));
        memory = step.memory;
        previous = raw;
        told.push(...step.tracked);
    });
    return told;
};

const playSetup = (snapshots: readonly OnboardingSetup[], minutes?: number): Tracked[] => {
    let memory: SetupMemory = NO_SETUP;
    let previous: OnboardingSetup = { state: `idle` };
    const told: Tracked[] = [];
    for (const raw of snapshots) {
        const step = setupEvents(raw, previous, memory, { minutes, now: NOW });
        memory = step.memory;
        previous = raw;
        told.push(...step.tracked);
    }
    return told;
};

const actions = (told: readonly Tracked[]): string[] => told.map(([, properties]) => String(properties[`action`]));

describe(`a reason fit to send`, () => {
    it(`names no home folder, account, or any other path`, () => {
        const said = `could not write C:\\Users\\prf game\\.intentic\\image-cache\\x\\blobs: access denied for prf game`;
        expect(eventReason(said, LOG)).toBe(`could not write <path> access denied for <user>`);
        expect(eventReason(`the lock at /home/ann/.intentic/image-cache/lock is held`)).toBe(`the lock at <path> is held`);
        expect(eventReason(`cannot open /var/run/docker.sock`)).toBe(`cannot open <path>`);
    });

    it(`takes out a profile name with a space in it when no log names the home`, () => {
        expect(eventReason(`C:\\Users\\prf game\\.intentic\\engine: denied to prf game`)).toBe(`<path> denied to <user>`);
    });

    it(`keeps what explains it: an image, a URL, Docker's pipe`, () => {
        const said = `ghcr.io/intentic/sandbox:stable: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`;
        expect(eventReason(said)).toBe(said);
        expect(eventReason(`GET https://ghcr.io/v2/intentic/sandbox/manifests/stable: 503`)).toBe(
            `GET https://ghcr.io/v2/intentic/sandbox/manifests/stable: 503`,
        );
    });
});

describe(`the download's events`, () => {
    it(`tells a failure its phase, exit, reason and how far it got, and whether it tries again`, () => {
        const failure = {
            phase: `image`,
            exitCode: 1,
            reason: `could not fetch ghcr.io/intentic/sandbox:stable ahead: verify C:\\Users\\prf game\\.intentic\\image-cache\\blob failed`,
            log: LOG,
        } as const;
        const told = playPrefetch([
            prefetch(`running`, { attempt: 1, done: 10, total: 900 }),
            prefetch(`failed`, { attempt: 1, done: 700, total: 900, failure, retryAt: 1_791_000_030 }),
        ]);
        expect(told).toEqual([
            [`onboarding_prefetch`, { action: `started` }],
            [
                `onboarding_prefetch`,
                {
                    action: `failed`,
                    phase: `image`,
                    exitCode: 1,
                    reason: `could not fetch ghcr.io/intentic/sandbox:stable ahead: verify <path> failed`,
                    done: 700,
                    total: 900,
                    attempt: 1,
                    willRetry: true,
                },
            ],
        ]);
    });

    it(`tells its automatic retry as a retry, and the give-up after it as a failure that will not retry`, () => {
        const failure = { phase: `engine`, reason: `boom` } as const;
        const told = playPrefetch([
            prefetch(`running`, { attempt: 1 }),
            prefetch(`failed`, { attempt: 1, failure, retryAt: 1 }),
            prefetch(`running`, { attempt: 2 }),
            prefetch(`failed`, { attempt: 2, failure }),
        ]);
        expect(actions(told)).toEqual([`started`, `failed`, `retried`, `failed`]);
        expect(told[2]?.[1]).toEqual({ action: `retried`, attempt: 2 });
        expect(told[3]?.[1][`willRetry`]).toBe(false);
    });

    it(`tells stepping aside for a setup, and coming back after it, apart from a failure`, () => {
        const told = playPrefetch([
            prefetch(`running`, { attempt: 1, done: 100, total: 900 }),
            prefetch(`yielded`, { attempt: 1, done: 100, total: 900 }),
            prefetch(`running`, { attempt: 2, done: 100, total: 900 }),
            prefetch(`done`, { attempt: 2, done: 900, total: 900 }),
        ]);
        expect(told).toEqual([
            [`onboarding_prefetch`, { action: `started` }],
            [`onboarding_prefetch`, { action: `yielded`, done: 100, total: 900 }],
            [`onboarding_prefetch`, { action: `resumed`, from: `yielded` }],
            [`onboarding_prefetch`, { action: `done`, seconds: 0, bytes: 900 }],
        ]);
    });

    it(`times a finished download from its first start, not from its resume`, () => {
        const told = playPrefetch(
            [prefetch(`running`, { attempt: 1 }), prefetch(`paused`), prefetch(`running`, { attempt: 2 }), prefetch(`done`, { done: 5 })],
            (index) => NOW + index * 60_000,
        );
        expect(told.at(-1)).toEqual([`onboarding_prefetch`, { action: `done`, seconds: 180, bytes: 5 }]);
    });

    it(`tells why there was nothing to fetch`, () => {
        expect(playPrefetch([prefetch(`skipped`, { skipped: `imageInDocker` })])).toEqual([
            [`onboarding_prefetch`, { action: `skipped`, why: `imageInDocker` }],
        ]);
    });

    it(`says nothing for progress within a state`, () => {
        const told = playPrefetch([
            prefetch(`running`, { attempt: 1, done: 1, total: 9 }),
            prefetch(`running`, { attempt: 1, done: 5, total: 9 }),
            prefetch(`running`, { attempt: 1, done: 5, total: 9 }),
        ]);
        expect(actions(told)).toEqual([`started`]);
    });
});

describe(`the download as This computer's card draws it`, () => {
    it(`gives a failure its reason, without paths, and whether a retry is coming`, () => {
        const failed = prefetch(`failed`, {
            done: 7,
            total: 9,
            failure: { phase: `image`, reason: `error writing C:\\Users\\prf game\\.intentic\\x`, log: LOG },
            retryAt: 1,
        });
        expect(mapPrefetch(failed)).toEqual({ state: `failed`, done: 7, total: 9, reason: `error writing <path>`, retrying: true });
        expect(mapPrefetch({ ...failed, retryAt: undefined }).retrying).toBe(false);
    });

    it(`draws every other state as the bar it was`, () => {
        expect(mapPrefetch(prefetch(`yielded`, { done: 1, total: 2, attempt: 1 }))).toEqual({ state: `yielded`, done: 1, total: 2 });
    });
});

describe(`the PC setup's events`, () => {
    it(`tells a resume after a restart from what the app kept across it, once`, () => {
        const resumed: OnboardingSetup = { state: `running`, percent: 0, resumed: true, parkedAt: NOW / 1000 - 30 * 60 };
        const told = playSetup([resumed, { ...resumed, percent: 40 }, { state: `ready` }], 25);
        expect(told).toEqual([
            [`onboarding_setup`, { action: `resumedAfterRestart`, minutes: 30 }],
            [`onboarding_setup`, { action: `ready`, minutes: 25 }],
        ]);
    });

    it(`no longer reads a retry after Windows' permission prompt as a resume after a restart`, () => {
        const told = playSetup([
            { state: `running`, percent: 0 },
            { state: `waiting`, for: `admin` },
            { state: `running`, percent: 0 },
        ]);
        expect(actions(told)).toEqual([`adminRefused`]);
    });

    it(`tells a setup gone quiet once, with where it was, and again for a later quiet stretch`, () => {
        const quiet = NOW / 1000 - 21 * 60;
        const stalled: OnboardingSetup = { state: `running`, percent: 38, step: `Turning on WSL`, quietSince: quiet };
        const told = playSetup([
            { state: `running`, percent: 38, step: `Turning on WSL` },
            stalled,
            stalled,
            { state: `running`, percent: 50, step: `Installing the engine` },
            { ...stalled, percent: 50, quietSince: quiet + 120 },
        ]);
        expect(told).toEqual([
            [`onboarding_setup`, { action: `stalled`, step: `Turning on WSL`, percent: 38, minutes: 21 }],
            [`onboarding_setup`, { action: `stalled`, step: `Turning on WSL`, percent: 50, minutes: 19 }],
        ]);
    });

    it(`tells a failure the step it stopped at and its reason, scrubbed`, () => {
        const told = playSetup([
            { state: `running`, percent: 10, step: `Downloading the engine` },
            { state: `failed`, reason: `could not write C:\\Users\\prf game\\.intentic\\engine: denied` },
        ]);
        expect(told).toEqual([[`onboarding_setup`, { action: `failed`, step: `Downloading the engine`, reason: `could not write <path> denied` }]]);
    });

    it(`tells a restart asked for, and nothing for a sign-out`, () => {
        expect(actions(playSetup([{ state: `waiting`, for: `restart` }]))).toEqual([`restartAsked`]);
        expect(playSetup([{ state: `waiting`, for: `signOut` }])).toEqual([]);
    });
});

describe(`a setup the last run of the app left behind`, () => {
    it(`is told with how long ago it started and the requirement it was on`, () => {
        expect(orphanedEvent({ startedAt: NOW / 1000 - 110 * 60, step: `wsl-features` }, NOW)).toEqual([
            `onboarding_setup`,
            { action: `orphaned`, step: `wsl-features`, minutes: 110 },
        ]);
        expect(orphanedEvent({}, NOW)).toEqual([`onboarding_setup`, { action: `orphaned`, step: undefined, minutes: undefined }]);
        expect(orphanedEvent(undefined, NOW)).toBeUndefined();
    });
});
