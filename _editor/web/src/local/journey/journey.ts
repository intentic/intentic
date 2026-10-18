import { t } from "@intentic/ui/i18n";
import type { LocalFolderSandbox, LocalMachineState } from "../../app/environments/localHost";

// A FOLDER'S WAY TO AN AGENT, AS STEPS: sign in, get this computer's sandbox ready, copy the folder in. The dialog that
// asks (LocalProjectDialog.vue) lists them before the press, and the card in the window's corner (LocalMachineCard.vue)
// ticks them off as the app goes, so each step is said for what it is and only while it is the one under way. They
// used to run together: the dialog drew the folder being carried into the house over a button that only signed the
// reader in, and the card went from "finish signing in" to a copy to "stopped" with nothing saying which step was
// which (2026-10-18). Pure, so every state's steps are tested by value (journey.test.ts).

/** How a step stands: done, the reader's next press, under way by itself, waiting on the reader, failed, or not yet. */
export type JourneyStepState = `done` | `current` | `running` | `attention` | `failed` | `todo`;

export type JourneyStepKey = `signIn` | `sandbox` | `copy`;

export interface JourneyStep {
    readonly key: JourneyStepKey;
    readonly title: string;
    /** What the step is doing, or waits for, in a few words. */
    readonly note: string | undefined;
    readonly state: JourneyStepState;
}

export interface JourneyFacts {
    /** This computer's sandbox, as the app says. */
    readonly machine: LocalMachineState | undefined;
    /** The folder on its way into it; none before it is asked in. */
    readonly folder: LocalFolderSandbox | undefined;
    /** The folder's name, for its step. */
    readonly name: string;
    /** The reader is in the browser signing in, sent there from this window. */
    readonly signingIn: boolean;
    /** The sign-in is a step of this way: nobody was signed in when it began. */
    readonly withSignIn: boolean;
}

const step = (key: JourneyStepKey, title: string, state: JourneyStepState, note?: string): JourneyStep => ({ key, title, state, note });

const signInStep = (machine: LocalMachineState | undefined, signingIn: boolean): JourneyStep => {
    const title = t(`local.journey.signIn.title`);
    if (machine?.state !== `signedOut`) {
        return step(`signIn`, title, `done`);
    }
    return signingIn ? step(`signIn`, title, `running`, t(`local.journey.signIn.inBrowser`)) : step(`signIn`, title, `current`, t(`local.journey.signIn.opens`));
};

const sandboxStep = (machine: LocalMachineState | undefined): JourneyStep => {
    const title = t(`local.journey.sandbox.title`);
    switch (machine?.state) {
        case undefined:
        case `signedOut`:
            return step(`sandbox`, title, `todo`, t(`local.journey.sandbox.once`));
        case `signedIn`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.signedIn`));
        case `creating`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.creating`, { percent: machine.percent }));
        case `interrupted`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.interrupted`));
        case `starting`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.starting`));
        case `stopped`:
            return machine.reason === undefined
                ? step(`sandbox`, title, `todo`, t(`local.journey.sandbox.stopped`))
                : step(`sandbox`, title, `failed`, t(`local.journey.sandbox.startFailed`));
        case `needsDocker`:
            return step(`sandbox`, title, `attention`, t(`local.journey.sandbox.needsDocker.${machine.reason}`));
        case `waiting`:
            return step(`sandbox`, title, `attention`, t(`local.journey.sandbox.waiting.${machine.for}`));
        case `failed`:
            return step(`sandbox`, title, `failed`, t(`local.journey.sandbox.failed`));
        case `gone`:
            return step(`sandbox`, title, `failed`, t(`local.journey.sandbox.gone`));
        case `ready`:
            return step(`sandbox`, title, `done`);
    }
};

const copyStep = (machine: LocalMachineState | undefined, folder: LocalFolderSandbox | undefined, name: string): JourneyStep => {
    const title = t(`local.journey.copy.title`, { name });
    // Nothing moves before the sandbox is up: the folder stays where it is, and waits.
    if (machine?.state !== `ready` || folder === undefined) {
        return step(`copy`, title, `todo`, t(`local.journey.copy.stays`));
    }
    switch (folder.state) {
        case `queued`:
        case `attaching`:
            return step(`copy`, title, `running`, t(`local.journey.copy.adding`));
        case `copying`:
            return folder.status === `paused`
                ? step(`copy`, title, `attention`, t(`local.journey.copy.paused`))
                : step(`copy`, title, `running`, t(`local.journey.copy.copying`));
        case `failed`:
            return step(`copy`, title, `failed`, t(`local.journey.copy.failed`));
        case `ready`:
            return step(`copy`, title, `done`);
    }
};

/** The steps from this folder to an agent, as far as they have gone. */
export const journeyOf = (facts: JourneyFacts): readonly JourneyStep[] => {
    const steps = [sandboxStep(facts.machine), copyStep(facts.machine, facts.folder, facts.name)];
    return facts.withSignIn ? [signInStep(facts.machine, facts.signingIn), ...steps] : steps;
};

/** The step under way or waiting on the reader: the first one not done. */
export const activeStep = (steps: readonly JourneyStep[]): JourneyStep | undefined => steps.find((each) => each.state !== `done`);
