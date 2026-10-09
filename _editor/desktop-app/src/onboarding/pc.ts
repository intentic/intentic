import type { LocalOnboardingHost, LocalPcCheck, LocalPcSetup, LocalPrefetch, LocalRestartWhen } from "@intentic/web/local-host";
import { computed, ref } from "vue";
import { t } from "@intentic/ui/i18n";
import { track } from "../analytics";
import { scrubReason } from "../device/installTelemetry";
import {
    onOnboarding,
    onboardingPause,
    onboardingRecheck,
    onboardingRestart,
    onboardingSetUp,
    onboardingState,
    onboardingUseCloud,
    type OnboardingCheck,
    type OnboardingCheckRow,
    type OnboardingSnapshot,
    type OnboardingSetup,
} from "../desktop";

export type PcParts = Omit<LocalOnboardingHost, `firstTask` | `pickFolder` | `queueFirstTask` | `clearFirstTask`>;

const check = ref<LocalPcCheck | undefined>(undefined);
const prefetch = ref<LocalPrefetch | undefined>(undefined);
const setup = ref<LocalPcSetup>({ state: `idle` });

let started: Promise<void> | undefined;
let launched = false;
let prefetchStartedAt: number | undefined;
let lastCheckKey = ``;
let lastPrefetchKey = ``;

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

const mapCheck = (raw: OnboardingCheck | undefined): LocalPcCheck | undefined => {
    if (raw === undefined) {
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

const checkKey = (raw: OnboardingCheck | undefined): string => {
    if (raw === undefined) {
        return ``;
    }
    return [
        raw.state,
        raw.engine ?? ``,
        raw.restart,
        raw.admin,
        raw.rows
            .filter((row) => row.state === `blocked`)
            .map((row) => row.id)
            .join(`,`),
    ].join(`|`);
};

const prefetchKey = (raw: LocalPrefetch | undefined): string =>
    raw === undefined ? `` : `${raw.state}|${raw.done}|${raw.total}`;

const trackCheckIfChanged = (snapshot: OnboardingSnapshot): void => {
    const raw = snapshot.check;
    const key = checkKey(raw);
    if (key === lastCheckKey || raw === undefined) {
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

const trackPrefetchIfChanged = (raw: LocalPrefetch | undefined, previous: LocalPrefetch | undefined): void => {
    if (raw === undefined) {
        return;
    }
    const key = prefetchKey(raw);
    if (key === lastPrefetchKey) {
        return;
    }
    const prevState = previous?.state;
    lastPrefetchKey = key;
    if (raw.state === `running` && prevState !== `running`) {
        if (prevState === `paused` || prevState === `metered`) {
            track(`onboarding_prefetch`, { action: `resumed` });
        } else {
            prefetchStartedAt = Date.now();
            track(`onboarding_prefetch`, { action: `started` });
        }
    }
    if (raw.state === `paused` && prevState !== `paused`) {
        track(`onboarding_prefetch`, { action: `paused` });
    }
    if (raw.state === `metered` && prevState !== `metered`) {
        track(`onboarding_prefetch`, { action: `metered` });
    }
    if (raw.state === `done` && prevState !== `done`) {
        const seconds =
            prefetchStartedAt === undefined ? undefined : Math.round((Date.now() - prefetchStartedAt) / 1000);
        track(`onboarding_prefetch`, { action: `done`, seconds, bytes: raw.done });
    }
    if (raw.state === `failed` && prevState !== `failed`) {
        track(`onboarding_prefetch`, { action: `failed` });
    }
};

let lastSetupState: OnboardingSetup[`state`] = `idle`;

const trackSetupTransition = (raw: OnboardingSetup, previous: OnboardingSetup): void => {
    if (raw.state === previous.state && raw.state !== `running`) {
        return;
    }
    if (raw.state === `running` && previous.state !== `running` && lastSetupState === `waiting`) {
        track(`onboarding_setup`, { action: `resumedAfterRestart` });
    }
    if (raw.state === `waiting` && previous.state !== `waiting`) {
        if (raw.for === `admin`) {
            track(`onboarding_setup`, { action: `adminRefused` });
        }
        if (raw.for === `restart`) {
            track(`onboarding_setup`, { action: `restartAsked` });
        }
    }
    if (raw.state === `ready` && previous.state !== `ready`) {
        const minutes = check.value?.minutes;
        track(`onboarding_setup`, { action: `ready`, minutes });
    }
    if (raw.state === `failed` && previous.state !== `failed`) {
        track(`onboarding_setup`, {
            action: `failed`,
            step: previous.state === `running` ? previous.step : undefined,
            reason: scrubReason(raw.reason, {}),
        });
    }
    lastSetupState = raw.state;
};

let previousSetupSnapshot: OnboardingSetup = { state: `idle` };

const apply = (snapshot: OnboardingSnapshot): void => {
    const previousPrefetch = prefetch.value;
    const previousSetup = previousSetupSnapshot;
    check.value = mapCheck(snapshot.check);
    if (snapshot.prefetch !== undefined) {
        trackPrefetchIfChanged(snapshot.prefetch, previousPrefetch);
        prefetch.value = snapshot.prefetch;
    }
    trackSetupTransition(snapshot.setup, previousSetup);
    setup.value = mapSetup(snapshot.setup);
    previousSetupSnapshot = snapshot.setup;
    if (!launched && snapshot.firstLaunch === true) {
        launched = true;
        track(`onboarding_launched`, {
            state: snapshot.check?.state ?? `unknown`,
            engine: snapshot.check?.engine ?? `unknown`,
        });
    }
    trackCheckIfChanged(snapshot);
};

const ensureListening = (): Promise<void> =>
    (started ??= (async () => {
        await onOnboarding(apply);
        apply(await onboardingState());
    })());

// Started with the host, not on import: the host is installed only where the app is behind the page (host.ts
// `installHost`), and a page without it (the built local face in a test's browser) has no events to listen to.
export const pcParts = (): PcParts => {
    void ensureListening().catch((error: unknown) => {
        console.error(`[onboarding] this PC's setup could not be followed:`, error);
    });
    return {
        check: computed(() => check.value),
        prefetch: computed(() => prefetch.value),
        setup,
        recheck: async () => {
            await ensureListening();
            await onboardingRecheck();
        },
        setUp: async () => {
            await ensureListening();
            track(`onboarding_setup`, { action: `pressed` });
            await onboardingSetUp();
        },
        pause: async (paused: boolean) => {
            await ensureListening();
            await onboardingPause(paused);
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
