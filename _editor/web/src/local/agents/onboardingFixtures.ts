import { ref, type Ref } from "vue";
import type {
    LocalCheckRow,
    LocalFirstTask,
    LocalOnboardingHost,
    LocalPcCheck,
    LocalPcSetup,
    LocalPrefetch,
    LocalRestartWhen,
} from "../../app/environments/localHost";

const row = (partial: LocalCheckRow): LocalCheckRow => partial;

export const FIXTURE_CHECKS = {
    needsSetup: {
        state: `needsSetup`,
        rows: [
            row({ id: `virt`, state: `met`, label: `Virtualization on`, detail: undefined, admin: false }),
            row({ id: `wsl`, state: `ours`, label: `Linux support for Windows (WSL)`, detail: undefined, admin: false }),
            row({ id: `engine`, state: `ours`, label: `Container engine`, detail: undefined, admin: false }),
        ],
        machine: `Windows 11, 16 GB memory, 214 GB free`,
        restart: true,
        admin: true,
        downloadBytes: 3_000_000_000,
        minutes: 15,
        engine: `intentic`,
    } satisfies LocalPcCheck,
    ready: {
        state: `ready`,
        rows: [row({ id: `engine`, state: `met`, label: `Container engine running`, detail: undefined, admin: false })],
        machine: `Windows 11, 16 GB memory`,
        restart: false,
        admin: false,
        downloadBytes: 0,
        minutes: 3,
        engine: `dockerDesktop`,
    } satisfies LocalPcCheck,
    cantRun: {
        state: `cantRun`,
        rows: [row({ id: `memory`, state: `blocked`, label: `Not enough memory`, detail: `This PC has under 8 GB of RAM.`, admin: false })],
        machine: `Windows 11, 4 GB memory`,
        restart: false,
        admin: false,
        downloadBytes: 0,
        minutes: 0,
        engine: undefined,
    } satisfies LocalPcCheck,
} as const;

export type AgentsFixtureName =
    | `needsSetup`
    | `pcReady`
    | `prefetch`
    | `settingUp`
    | `needsYou`
    | `restart`
    | `restartScheduled`
    | `admin`
    | `signOut`
    | `setupFailed`
    | `cantRun`
    | `sandboxReady`;

export const onboardingFixture = (name: AgentsFixtureName): LocalOnboardingHost => {
    // Refs match LocalOnboardingHost; the design kit swaps fixtures by replacing the whole host object.
    const check = ref<LocalPcCheck | undefined>(FIXTURE_CHECKS.needsSetup);
    const prefetch = ref<LocalPrefetch | undefined>({ state: `running`, done: 400_000_000, total: 3_000_000_000 });
    const setup = ref<LocalPcSetup>({ state: `idle` });
    const firstTask = ref<LocalFirstTask | undefined>({
        folder: `C:\\Users\\you\\code\\my-app`,
        text: `Add a dark mode toggle to the settings page.`,
        queuedAt: Date.now() / 1000,
        state: `queued`,
        reason: undefined,
    });

    const apply = (): void => {
        switch (name) {
            case `needsSetup`:
                check.value = FIXTURE_CHECKS.needsSetup;
                setup.value = { state: `idle` };
                break;
            case `pcReady`:
                check.value = FIXTURE_CHECKS.ready;
                setup.value = { state: `idle` };
                prefetch.value = { state: `done`, done: 3_000_000_000, total: 3_000_000_000 };
                break;
            case `prefetch`:
                check.value = FIXTURE_CHECKS.needsSetup;
                prefetch.value = { state: `metered`, done: 0, total: 3_000_000_000 };
                break;
            case `settingUp`:
                check.value = FIXTURE_CHECKS.needsSetup;
                setup.value = { state: `running`, step: `Installing the container engine`, percent: 62 };
                break;
            case `needsYou`:
                check.value = FIXTURE_CHECKS.needsSetup;
                setup.value = {
                    state: `running`,
                    step: `Turning on Linux support for Windows`,
                    percent: 38,
                    needsYou: true,
                };
                break;
            case `restart`:
                check.value = FIXTURE_CHECKS.needsSetup;
                setup.value = { state: `waiting`, for: `restart` };
                break;
            case `restartScheduled`: {
                check.value = FIXTURE_CHECKS.needsSetup;
                const restartAt = Math.floor(Date.now() / 1000) + 10 * 60;
                setup.value = { state: `waiting`, for: `restart`, restartAt };
                break;
            }
            case `admin`:
                setup.value = { state: `waiting`, for: `admin` };
                break;
            case `signOut`:
                setup.value = { state: `waiting`, for: `signOut` };
                break;
            case `setupFailed`:
                setup.value = { state: `failed`, reason: `The engine installer stopped with an error.` };
                break;
            case `cantRun`:
                check.value = FIXTURE_CHECKS.cantRun;
                break;
            case `sandboxReady`:
                check.value = FIXTURE_CHECKS.ready;
                setup.value = { state: `ready` };
                firstTask.value = { ...firstTask.value!, state: `sent` };
                break;
        }
    };
    apply();

    const noop = (): Promise<void> => Promise.resolve();
    return {
        check,
        prefetch,
        setup,
        firstTask,
        recheck: noop,
        setUp: noop,
        pause: noop,
        restart: (_when: LocalRestartWhen) => noop(),
        pickFolder: () => Promise.resolve(undefined),
        queueFirstTask: noop,
        clearFirstTask: noop,
        useCloud: noop,
        track: () => undefined,
    };
};
