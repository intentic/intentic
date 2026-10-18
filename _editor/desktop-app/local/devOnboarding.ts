import type { OnboardingCheck, OnboardingCheckRow } from "../src/desktop";

const GIB = 1024 ** 3;
// What `ic docker prepare --dry-run` says of a Windows 11 laptop: the rows as onboarding.rs passes them on, with ic's own
// titles, so a row this app has no words for shows ic's rather than its id.
const row = (id: string, state: OnboardingCheckRow[`state`], title: string, detail?: string, admin = false): OnboardingCheckRow =>
    detail === undefined ? { id, state, title, admin } : { id, state, title, detail, admin };
const MET: readonly OnboardingCheckRow[] = [
    row(`memory`, `met`, `Physical memory`),
    row(`windows-edition`, `met`, `Windows edition`),
    row(`virtualization`, `met`, `Hardware virtualization`),
    row(`disk-space`, `met`, `Free disk space`),
];
const LAPTOP = { os: `Windows 11 Home`, build: 22631, memoryBytes: 16 * GIB, freeBytes: 214 * GIB, cpus: 8, virtualization: true };
export const CHECK_READY: OnboardingCheck = {
    state: `ready`,
    rows: [...MET, row(`wsl`, `met`, `WSL2`), row(`engine`, `met`, `the intentic engine running`)],
    machine: LAPTOP,
    restart: false,
    admin: false,
    downloadBytes: 0,
    minutes: 2,
    engine: `intentic`,
};
export const CHECK_NEEDS_SETUP: OnboardingCheck = {
    state: `needsSetup`,
    rows: [
        row(`wsl-features`, `ours`, `Windows features for Docker`, `Virtual Machine Platform and WSL are off on this PC.`, true),
        row(`engine`, `ours`, `the intentic engine`, `the intentic engine is not installed yet, and WSL2 has to finish first.`),
        ...MET,
    ],
    machine: LAPTOP,
    restart: true,
    admin: true,
    downloadBytes: 2_900_000_000,
    minutes: 18,
    engine: `intentic`,
};
export const CHECK_CANT_RUN: OnboardingCheck = {
    state: `cantRun`,
    rows: [
        row(`slat`, `blocked`, `Processor features`, `This processor lacks second-level address translation, which Windows needs to run any virtual machine. No setting adds it.`),
        row(`memory`, `blocked`, `Physical memory`, `This PC has 4 GB of memory; a sandbox needs at least 8 GB.`),
        row(`windows-edition`, `met`, `Windows edition`),
    ],
    machine: { ...LAPTOP, memoryBytes: 4 * GIB, freeBytes: 61 * GIB },
    restart: false,
    admin: false,
    downloadBytes: 0,
    minutes: 0,
};
export const CHECK_UNKNOWN: OnboardingCheck = {
    state: `unknown`,
    rows: [row(`check`, `blocked`, ``, `ic docker prepare --dry-run did not answer within 2 minutes`)],
    restart: false,
    admin: false,
    downloadBytes: 0,
    minutes: 0,
};
