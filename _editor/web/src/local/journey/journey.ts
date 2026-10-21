import { t } from "@intentic/ui/i18n";
import type { LocalFolderSetup } from "../../app/environments/localHost";
import { copyMeasureOf } from "../setup/copyMeasure";

// A FOLDER'S WAY TO AN AGENT, AS STEPS: sign in, make the folder's own sandbox, copy the folder in. The folder's page
// for it (setup/LocalSandboxSetup.vue) lists them before the press and ticks them off as the app goes, so each step is
// said for what it is and only while it is the one under way. They used to run together: the ask drew the folder being
// carried into the house over a button that only signed the reader in, and the progress went from "finish signing in"
// to a copy to "stopped" with nothing saying which step was which (2026-10-18). Pure, so every state's steps are tested
// by value (journey.test.ts).

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
    /** The folder's setup, as the app says; none before it is asked for. */
    readonly setup: LocalFolderSetup | undefined;
    /** Before the press: whether someone is signed in (the dialog's preview). */
    readonly signedIn: boolean;
    /** The folder's name, for its step. */
    readonly name: string;
    /** The reader is in the browser signing in, sent there from this window. */
    readonly signingIn: boolean;
    /** The sign-in is a step of this way: nobody was signed in when it began. */
    readonly withSignIn: boolean;
}

const step = (key: JourneyStepKey, title: string, state: JourneyStepState, note?: string): JourneyStep => ({ key, title, state, note });

const signedOutNow = (facts: JourneyFacts): boolean => (facts.setup === undefined ? !facts.signedIn : facts.setup.state === `signedOut`);

const signInStep = (facts: JourneyFacts): JourneyStep => {
    const title = t(`local.journey.signIn.title`);
    if (!signedOutNow(facts)) {
        return step(`signIn`, title, `done`);
    }
    return facts.signingIn ? step(`signIn`, title, `running`, t(`local.journey.signIn.inBrowser`)) : step(`signIn`, title, `current`, t(`local.journey.signIn.opens`));
};

const sandboxStep = (setup: LocalFolderSetup | undefined): JourneyStep => {
    const title = t(`local.journey.sandbox.title`);
    switch (setup?.state) {
        case undefined:
        case `signedOut`:
            return step(`sandbox`, title, `todo`, t(`local.journey.sandbox.once`));
        case `signedIn`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.signedIn`));
        case `queued`:
            return setup.behind === undefined
                ? step(`sandbox`, title, `running`, t(`local.journey.sandbox.signedIn`))
                : step(`sandbox`, title, `running`, t(`local.journey.sandbox.behind`));
        case `creating`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.creating`, { percent: setup.percent }));
        case `interrupted`:
            return step(`sandbox`, title, `running`, t(`local.journey.sandbox.interrupted`));
        case `needsDocker`:
            return step(`sandbox`, title, `attention`, t(`local.journey.sandbox.needsDocker.${setup.reason}`));
        case `waiting`:
            return step(`sandbox`, title, `attention`, t(`local.journey.sandbox.waiting.${setup.for}`));
        case `failed`:
            return setup.made ? step(`sandbox`, title, `done`) : step(`sandbox`, title, `failed`, t(`local.journey.sandbox.failed`));
        case `copying`:
        case `ready`:
            return step(`sandbox`, title, `done`);
    }
};

const copyStep = (setup: LocalFolderSetup | undefined, name: string): JourneyStep => {
    const title = t(`local.journey.copy.title`, { name });
    switch (setup?.state) {
        case `copying`:
            return setup.status === `paused`
                ? step(`copy`, title, `attention`, t(`local.journey.copy.paused`))
                : step(`copy`, title, `running`, copyMeasureOf(setup).step);
        case `ready`:
            return step(`copy`, title, `done`);
        case `failed`:
            return setup.made ? step(`copy`, title, `failed`, t(`local.journey.copy.failed`)) : step(`copy`, title, `todo`, t(`local.journey.copy.stays`));
        // Nothing moves before the sandbox is up: the folder stays where it is, and waits.
        default:
            return step(`copy`, title, `todo`, t(`local.journey.copy.stays`));
    }
};

/** The steps from this folder to an agent, as far as they have gone. */
export const journeyOf = (facts: JourneyFacts): readonly JourneyStep[] => {
    const steps = [sandboxStep(facts.setup), copyStep(facts.setup, facts.name)];
    return facts.withSignIn ? [signInStep(facts), ...steps] : steps;
};

/** The step under way or waiting on the reader: the first one not done. */
export const activeStep = (steps: readonly JourneyStep[]): JourneyStep | undefined => steps.find((each) => each.state !== `done`);
