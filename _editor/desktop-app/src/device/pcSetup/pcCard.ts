import type { LocalCheckRow, LocalFirstTask, LocalPcCheck, LocalPcSetup } from "@intentic/web/local-host";
import type { MachineStanding } from "../../desktop";

// THIS PC'S OWN SETUP, ON THIS COMPUTER (2026-10-12): one card on This computer (PcSetupCard.vue) for what a new Windows
// PC needs before agents run on it (onboarding.rs: the check made at launch, "Set up this PC", the restart it asks for),
// the sign-in, and the first task written meanwhile. It replaced the local shell's Agents view, a page and a rail tile of
// its own whose signed-out checklist listed every requirement already met as a green dot, several under their raw ids,
// and whose first-task step said its own heading twice. Pure, given what the app last said (pcCard.test.ts).

/**
 * What the card says, one phase at a time. `hidden`: nothing to say, off Windows or on a ready PC with someone signed in.
 * `signIn`: the PC is ready and nobody is signed in. `firstTaskFailed`: the first task did not start once it could.
 */
export type PcCardPhase =
    | `hidden`
    | `checking`
    | `checkUnknown`
    | `needsSetup`
    | `settingUp`
    | `restart`
    | `admin`
    | `signOut`
    | `setupFailed`
    | `cantRun`
    | `signIn`
    | `firstTaskFailed`;

export interface PcCardInput {
    /**
     * The app's own OS (desktop.ts `DesktopInfo.os`). Only Windows has this setup: elsewhere the app's check reads "needs
     * setup" whenever Docker is down (onboarding.rs `check_unix`), and This computer's Docker card already says that.
     */
    readonly os: string | undefined;
    /** The check of this PC (onboarding/pc.ts); undefined before it has answered once. */
    readonly check: LocalPcCheck | undefined;
    readonly setup: LocalPcSetup;
    /** Where this computer's own sandbox stands (machineSandbox.ts): `signedOut` is how the card knows nobody is signed in. */
    readonly machine: MachineStanding[`state`] | undefined;
    readonly firstTask: LocalFirstTask | undefined;
}

// This computer's sandbox made or being made: this PC was ready for it, so the check that runs at every launch has
// nothing new to say until it answers, and "Checking this PC…" over a working sandbox would be noise on every launch.
const MACHINE_MADE: ReadonlySet<MachineStanding[`state`]> = new Set([`ready`, `creating`, `interrupted`, `stopped`, `starting`]);

/**
 * The card's phase. The setup's own state first: it is newer than the check made before it ran, so a running, waiting or
 * failed setup is said whatever that check still says, and a finished one makes the PC ready even if no check has
 * looked since. Then what the check found. A ready PC is the card's business only while nobody is signed in (the
 * sign-in and the first task are on it) or while the first task failed to start.
 */
export const pcCardPhase = (input: PcCardInput): PcCardPhase => {
    if (input.os !== `windows`) {
        return `hidden`;
    }
    const setup = input.setup;
    switch (setup.state) {
        case `running`:
            return `settingUp`;
        case `waiting`:
            return setup.for;
        case `failed`:
            return `setupFailed`;
        case `idle`:
        case `ready`:
            break;
    }
    const check = input.check?.state;
    if (setup.state !== `ready` && check !== `ready`) {
        switch (check) {
            case undefined:
            case `checking`:
                return input.machine !== undefined && MACHINE_MADE.has(input.machine) ? `hidden` : `checking`;
            case `unknown`:
                return `checkUnknown`;
            case `cantRun`:
                return `cantRun`;
            case `needsSetup`:
                return `needsSetup`;
        }
    }
    if (input.machine === `signedOut`) {
        return `signIn`;
    }
    return input.firstTask?.state === `failed` ? `firstTaskFailed` : `hidden`;
};

// The phases with work for the reader on the card: the setup's own, the sign-in, and the first task, which can be
// written from the moment the PC's setup is offered. Checking, a check that could not say, and a PC that cannot run
// agents have none: the first two have not found out yet, and the last is offered a machine we host instead.
const WORK_PHASES: ReadonlySet<PcCardPhase> = new Set([
    `needsSetup`,
    `settingUp`,
    `restart`,
    `admin`,
    `signOut`,
    `setupFailed`,
    `signIn`,
    `firstTaskFailed`,
]);

/** Whether the phase carries the sign-in (while nobody is signed in), the download's progress and the first-task box. */
export const offersWork = (phase: PcCardPhase): boolean => WORK_PHASES.has(phase);

/** The rows still to do, the only ones listed: what is already fine is counted in the summary instead (`checksPassed`). */
export const unmetRows = (check: LocalPcCheck | undefined): readonly LocalCheckRow[] => check?.rows.filter((row) => row.state !== `met`) ?? [];

/** How many of the check's rows are met already, for the card's one summary line; undefined for a check with none. */
export const checksPassed = (check: LocalPcCheck | undefined): { readonly met: number; readonly total: number } | undefined => {
    const rows = check?.rows ?? [];
    return rows.length === 0 ? undefined : { met: rows.filter((row) => row.state === `met`).length, total: rows.length };
};

/** Minutes the running setup has left by the check's estimate, rounded up; undefined once it has none to give. */
export const minutesLeft = (check: LocalPcCheck | undefined, setup: LocalPcSetup): number | undefined => {
    if (setup.state !== `running` || check === undefined || check.minutes <= 0) {
        return undefined;
    }
    const left = Math.ceil(check.minutes * (1 - setup.percent / 100));
    return left > 0 ? left : undefined;
};

/* THE CARD AS THREE STEPS (2026-10-13). The card used to be three blocks of equal weight (where the PC stood, a sign-in
   row, an open first-task box) under a heading that read "Set up agents on this PC" beside a green check. Signed out on a
   ready PC, the largest thing on it was a box that could do nothing yet, and the one press that mattered was a small
   button between two rules. Now it is the way to agents in order: prepare this PC, sign in, give them a first task. Each
   step says where it stands, only the open ones carry their controls, and one press at a time is the loud one. */

/**
 * Where one step stands. `current`: the reader's next press. `running`: under way, nothing to do. `attention`: waiting on
 * the reader (a restart, Windows' permission, a sign-out). `failed`: stopped. `todo`: open, but not the next press.
 * `locked`: not open until an earlier step is done.
 */
export type StepState = `done` | `current` | `running` | `attention` | `failed` | `todo` | `locked`;

/** The first task as the card knows it: none written, a draft begun elsewhere, kept for later, started, or failed. */
export type TaskKind = `none` | `draft` | `kept` | `sent` | `failed`;

export interface PcSteps {
    /** This PC's own setup: Windows' features and the engine (onboarding.rs). */
    readonly pc: StepState;
    /** The sign-in agents work under. */
    readonly account: StepState;
    /** The first task, written while the rest is done. */
    readonly task: StepState;
}

// The phases without steps (`offersWork` is false for them) draw a card of their own and read `todo` here.
const PC_STEP = {
    hidden: `todo`,
    checking: `todo`,
    checkUnknown: `todo`,
    cantRun: `todo`,
    needsSetup: `current`,
    settingUp: `running`,
    restart: `attention`,
    admin: `attention`,
    signOut: `attention`,
    setupFailed: `failed`,
    signIn: `done`,
    firstTaskFailed: `done`,
} as const satisfies Record<PcCardPhase, StepState>;

/**
 * The three steps of a phase that has work on it (`offersWork`). The sign-in is the next press once this PC is ready or
 * its setup runs by itself, and only a press beside the setup's own before that, which it never waits for. The first
 * task opens once someone is signed in: a box offered to nobody was the card's loudest thing and could start nothing. A
 * draft begun from "Ask about this", a task kept or one that failed is shown whoever is signed in.
 */
export const pcSteps = (phase: PcCardPhase, signedOut: boolean, task: TaskKind): PcSteps => {
    const pc: StepState = PC_STEP[phase];
    const pcSettled = pc === `done` || pc === `running`;
    const account: StepState = !signedOut ? `done` : pcSettled ? `current` : `todo`;
    return { pc, account, task: taskStep(pc, signedOut, task) };
};

const taskStep = (pc: StepState, signedOut: boolean, task: TaskKind): StepState => {
    switch (task) {
        case `failed`:
            return `failed`;
        case `kept`:
        case `sent`:
            return `done`;
        case `draft`:
            return `current`;
        case `none`:
            break;
    }
    if (signedOut) {
        return `locked`;
    }
    // Signed in, this PC still being set up: the wait is what the box is for.
    return pc === `running` || pc === `done` ? `current` : `todo`;
};

/**
 * When a first task starts, said under it: once this PC is ready (`pc`), and someone has signed in (`pcAndSignIn`), as
 * soon as someone does (`signIn`), or right away (`now`).
 */
export type TaskStart = `pc` | `pcAndSignIn` | `signIn` | `now`;

export const taskStart = (phase: PcCardPhase, signedOut: boolean): TaskStart => {
    const pcReady = phase === `signIn` || phase === `firstTaskFailed` || phase === `hidden`;
    if (pcReady) {
        return signedOut ? `signIn` : `now`;
    }
    return signedOut ? `pcAndSignIn` : `pc`;
};
