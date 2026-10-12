import type { LocalOnboardingHost, LocalPcCheck, LocalPcSetup, LocalPrefetch, LocalRestartWhen } from "@intentic/web/local-host";
import { computed, shallowRef, watch, type Ref } from "vue";
import { t } from "@intentic/ui/i18n";
import { track } from "../analytics";
import {
    onOnboarding,
    onboardingPause,
    onboardingRecheck,
    onboardingRestart,
    onboardingSetUp,
    onboardingState,
    onboardingUseCloud,
    revealLog,
    type OnboardingCheck,
    type OnboardingCheckRow,
    type OnboardingPrefetch,
    type OnboardingSnapshot,
    type OnboardingSetup,
} from "../desktop";
import {
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

export type PcParts = Omit<LocalOnboardingHost, `firstTask` | `pickFolder` | `queueFirstTask` | `clearFirstTask`>;

// What the app last said, as it said it; the page's shapes are computed from these.
const rawCheck = shallowRef<OnboardingCheck | undefined>(undefined);
const rawPrefetch = shallowRef<OnboardingPrefetch | undefined>(undefined);
const rawSetup = shallowRef<OnboardingSetup>({ state: `idle` });

let listening: Promise<unknown> | undefined;
let started: Promise<void> | undefined;
let launched = false;
let lastCheckKey = ``;
let prefetchMemory: PrefetchMemory = NO_PREFETCH;
let setupMemory: SetupMemory = NO_SETUP;

// A row ic names that this app has no words for yet (a newer ic) shows its id rather than the key.
const rowLabel = (row: OnboardingCheckRow): string => {
    const label = t(`desktop.onboarding.rows.${row.id}`);
    return label === `desktop.onboarding.rows.${row.id}` ? row.id : label;
};

const formatMachine = (parts: NonNullable<OnboardingCheck[`machine`]>): string => {
    const memory =
        parts.memoryBytes === undefined
            ? undefined
            : t(`desktop.onboarding.machineMemory`, { gb: Math.round(parts.memoryBytes / (1024 * 1024 * 1024)) });
    const free =
        parts.freeBytes === undefined
            ? undefined
            : t(`desktop.onboarding.machineFree`, { gb: Math.round(parts.freeBytes / (1024 * 1024 * 1024)) });
    const bits = [parts.os, memory, free].filter((line): line is string => line !== undefined && line !== ``);
    return bits.join(t(`desktop.onboarding.machineSep`));
};

// The app says `null` until its check has answered once (onboarding.rs serializes the missing check as null). Before
// 2026-10-12 this read `null.state`, which threw on the first snapshot of every launch whose check was still running: the
// listener's start failed for good, and with it every button on the Agents page, "Set up this PC" included.
const mapCheck = (raw: OnboardingCheck | null | undefined): LocalPcCheck | undefined => {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    return {
        state: raw.state,
        rows: raw.rows.map((row) => ({
            id: row.id,
            state: row.state,
            label: rowLabel(row),
            detail: row.detail,
            admin: row.admin,
        })),
        machine: raw.machine === undefined ? undefined : formatMachine(raw.machine),
        restart: raw.restart,
        admin: raw.admin,
        downloadBytes: raw.downloadBytes,
        minutes: raw.minutes,
        engine: raw.engine,
    };
};

const mapSetup = (raw: OnboardingSetup): LocalPcSetup => {
    if (raw.state === `running`) {
        const needsYou = raw.needsYou === true;
        return {
            state: `running`,
            step: needsYou ? t(`desktop.onboarding.needsYou`) : raw.step,
            percent: raw.percent,
            needsYou: needsYou ? true : undefined,
            quietMinutes:
                raw.quietSince === undefined ? undefined : Math.max(0, Math.floor((Date.now() / 1000 - raw.quietSince) / 60)),
        };
    }
    if (raw.state === `waiting`) {
        return {
            state: `waiting`,
            for: raw.for,
            restartAt: raw.restartAt,
        };
    }
    return raw;
};

const check = computed(() => mapCheck(rawCheck.value));
const prefetch = computed((): LocalPrefetch | undefined => (rawPrefetch.value === undefined ? undefined : mapPrefetch(rawPrefetch.value)));
const setup = computed(() => mapSetup(rawSetup.value));

const checkKey = (raw: OnboardingCheck): string =>
    [
        raw.state,
        raw.engine ?? ``,
        raw.restart,
        raw.admin,
        raw.rows
            .filter((row) => row.state === `blocked`)
            .map((row) => row.id)
            .join(`,`),
    ].join(`|`);

const send = (tracked: readonly Tracked[]): void => {
    for (const [event, properties] of tracked) {
        track(event, properties);
    }
};

const trackCheckIfChanged = (raw: OnboardingCheck | undefined): void => {
    if (raw === undefined) {
        return;
    }
    const key = checkKey(raw);
    if (key === lastCheckKey) {
        return;
    }
    lastCheckKey = key;
    track(`onboarding_check`, {
        state: raw.state,
        engine: raw.engine ?? `unknown`,
        restart: raw.restart,
        admin: raw.admin,
        blocked: raw.rows.filter((row) => row.state === `blocked`).map((row) => row.id).join(`,`),
    });
    if (raw.state === `cantRun`) {
        track(`onboarding_cloud`, { action: `offered` });
    }
};

const apply = (snapshot: OnboardingSnapshot): void => {
    const now = Date.now();
    const raw = snapshot.check ?? undefined;
    rawCheck.value = raw;
    if (snapshot.prefetch !== undefined) {
        const told = prefetchEvents(snapshot.prefetch, rawPrefetch.value, prefetchMemory, now);
        prefetchMemory = told.memory;
        send(told.tracked);
        rawPrefetch.value = snapshot.prefetch;
    }
    const told = setupEvents(snapshot.setup, rawSetup.value, setupMemory, { minutes: raw?.minutes, now });
    setupMemory = told.memory;
    send(told.tracked);
    rawSetup.value = snapshot.setup;
    const orphaned = orphanedEvent(snapshot.orphaned, now);
    if (orphaned !== undefined) {
        send([orphaned]);
    }
    if (!launched && snapshot.firstLaunch === true) {
        launched = true;
        track(`onboarding_launched`, { state: raw?.state ?? `unknown`, engine: raw?.engine ?? `unknown` });
    }
    trackCheckIfChanged(raw);
};

// Listening and the first read, once; a start that failed is tried again by the next ask rather than kept as a
// rejection every button would then fail on. The listener itself is kept apart, so a retry never adds a second one.
const startListening = async (): Promise<void> => {
    try {
        listening ??= onOnboarding(apply);
        await listening;
    } catch (error) {
        listening = undefined;
        throw error;
    }
    apply(await onboardingState());
};

const ensureListening = async (): Promise<void> => {
    started ??= startListening();
    try {
        await started;
    } catch (error) {
        started = undefined;
        throw error;
    }
};

// For a caller that only wants the page kept current: a failure to listen is said in the console, never thrown.
const followQuietly = async (): Promise<void> => {
    try {
        await ensureListening();
    } catch (error) {
        console.error(`[onboarding] this PC's setup could not be followed:`, error);
    }
};

const answered = (raw: OnboardingCheck | undefined): raw is OnboardingCheck => raw !== undefined && raw.state !== `checking`;

/**
 * This PC's check as it stands, once it has answered: never undefined, never `checking`. What a setup handed over from the
 * workspace asks before it runs (device/setup.ts), and This device's card. The check is `ic docker prepare --dry-run`,
 * started at launch and bounded at two minutes (onboarding.rs `PREPARE_DEADLINE`); one that cannot answer answers
 * `unknown`. Rejects only when the app cannot be asked at all.
 */
export const currentPcCheck = async (): Promise<OnboardingCheck> => {
    await ensureListening();
    const now = rawCheck.value;
    if (answered(now)) {
        return now;
    }
    return new Promise((resolve) => {
        const stop = watch(rawCheck, (raw) => {
            if (answered(raw)) {
                stop();
                resolve(raw);
            }
        });
    });
};

/** This PC's own setup as the app tells it, live: what a handed-over setup parked behind it watches for its end. */
export const followPcSetup = (): Readonly<Ref<OnboardingSetup>> => {
    void followQuietly();
    return rawSetup;
};

/**
 * "Set up this PC": the Agents page's button, This device's card, and a handed-over setup that finds this PC not ready
 * all start the same one setup (`ic docker prepare --yes`); a second press while it runs changes nothing. `from` names
 * the button, for the funnel.
 */
export const setUpThisPc = async (from = `agents`): Promise<void> => {
    await ensureListening();
    track(`onboarding_setup`, { action: `pressed`, from });
    await onboardingSetUp();
};

// Started with the host, not on import: the host is installed only where the app is behind the page (host.ts
// `installHost`), and a page without it (the built local face in a test's browser) has no events to listen to.
export const pcParts = (): PcParts => {
    void followQuietly();
    return {
        check,
        prefetch,
        setup,
        recheck: async () => {
            await ensureListening();
            await onboardingRecheck();
        },
        setUp: () => setUpThisPc(`agents`),
        pause: async (paused: boolean) => {
            await ensureListening();
            await onboardingPause(paused);
        },
        retryPrefetch: async () => {
            await ensureListening();
            track(`onboarding_prefetch`, { action: `retryPressed` });
            // Resuming a failed download starts it again (onboarding.rs `onboarding_pause`).
            await onboardingPause(false);
        },
        setUpAgain: async () => {
            await ensureListening();
            track(`onboarding_setup`, { action: `again` });
            await onboardingSetUp(true);
        },
        showSetupLog: async () => {
            const raw = rawSetup.value;
            const log = raw.state === `running` ? raw.log : undefined;
            if (log !== undefined) {
                await revealLog(log);
            }
        },
        restart: async (when: LocalRestartWhen) => {
            await ensureListening();
            track(`onboarding_setup`, { action: `restart`, when });
            await onboardingRestart(when);
        },
        useCloud: async () => {
            await ensureListening();
            track(`onboarding_cloud`, { action: `chosen` });
            await onboardingUseCloud();
        },
        track: (event, properties) => {
            if (event.startsWith(`onboarding_`)) {
                track(event, properties);
            }
        },
    };
};
