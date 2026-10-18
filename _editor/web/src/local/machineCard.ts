import { t } from "@intentic/ui/i18n";
import type { LocalFolderSandbox, LocalMachineSandbox } from "../app/environments/localHost";
import { HOUSE_STAGES, type HouseStage, stageOfPhase } from "./house/agentHouse";
import { type JourneyStep, journeyOf } from "./journey/journey";
import { stageHeadline } from "./projectWords";

// WHAT A LOCAL WINDOW SAYS ABOUT THIS COMPUTER'S SANDBOX AND ITS FOLDER: the card in the window's corner
// (LocalMachineCard.vue) and the folder's own button (LocalFiles.vue), read off what the app says (its machine_sandbox.rs,
// through the host). Every window carries the card while the sandbox is not ready, since every folder's way to an agent
// goes through it; a folder on its way in has the card say how far it is. Pure, so every state's words and buttons are
// tested by value (machineCard.test.ts).

/** What the card's buttons do. */
export type MachineCardAction =
    // The app's own verbs (the host's `act`).
    | `signIn`
    // The same sign-in, its page opened again: the reader was sent to the browser already, and may have lost the tab.
    | `signInAgain`
    | `startDocker`
    | `retry`
    | `log`
    | `start`
    | `recreate`
    // This computer's page, where anything with more than a button to it is drawn (Docker, the requirements).
    | `details`
    // The folder's sandbox, opened on the folder; the folder put in line again.
    | `open`
    | `retryFolder`;

export interface MachineCard {
    /** What it is about: this computer's sandbox, or this window's folder going into it. */
    readonly about: `machine` | `folder`;
    /** How it is going: under way, waiting on the reader, done, or stopped short. */
    readonly tone: `working` | `waiting` | `ready` | `failed`;
    /** How much of the house stands. */
    readonly stage: HouseStage;
    readonly title: string;
    readonly detail: string | undefined;
    /** How far it is, where it is measured (the sandbox's setup). */
    readonly percent: number | undefined;
    /** The setup's running step, in its own words. */
    readonly step: string | undefined;
    /** The card folded to one line. */
    readonly short: string;
    /** The first is the primary press. */
    readonly actions: readonly MachineCardAction[];
    /** What the card is showing, for remembering it was folded: a new state unfolds it again. */
    readonly key: string;
    /** This window's folder on its way to an agent, step by step (journey.ts): the sign-in, the sandbox, the copy. */
    readonly steps: readonly JourneyStep[] | undefined;
    /**
     * Whether the agent's house is drawn: not while the reader is still to sign in, when nothing of the sandbox is under
     * way and the picture would show a house going up and a folder carried into it for a press that only signs in.
     */
    readonly picture: boolean;
}

export interface CardFacts {
    readonly machine: LocalMachineSandbox | undefined;
    readonly folder: LocalFolderSandbox | undefined;
    /** This computer's sandbox became ready moments ago, while this window watched. */
    readonly justReady: boolean;
    /** This window's folder finished going in moments ago, while this window watched. */
    readonly folderJustReady: boolean;
    /** This window sent the reader to the browser to sign in, and the app has not heard who signed in yet. */
    readonly signingIn?: boolean;
    /** The sign-in is a step of this window's folder's way in: nobody was signed in when it was asked for. */
    readonly withSignIn?: boolean;
}

// The house of this computer's sandbox stands with its lights on once it answers: moving in is a folder's own copy.
const MACHINE_TOP: HouseStage = `lit`;
const machineStage = (phase: string | undefined): HouseStage => {
    const stage = stageOfPhase(phase);
    return HOUSE_STAGES.indexOf(stage) > HOUSE_STAGES.indexOf(MACHINE_TOP) ? MACHINE_TOP : stage;
};

type Draft = Omit<MachineCard, `short` | `key` | `percent` | `step` | `steps` | `picture`> & Partial<Pick<MachineCard, `short` | `percent` | `step`>>;

const card = (draft: Draft, key: string): MachineCard => ({
    percent: undefined,
    step: undefined,
    short: draft.title,
    steps: undefined,
    picture: true,
    ...draft,
    key,
});

// This window's folder once the sandbox is up: being added, its first copy, in, or turned down.
const folderCard = (folder: LocalFolderSandbox, justIn: boolean): MachineCard | undefined => {
    const name = folder.name;
    switch (folder.state) {
        case `queued`:
        case `attaching`:
            return card({ about: `folder`, tone: `working`, stage: `moving`, title: t(`local.machine.folder.adding`, { name }), detail: undefined, actions: [] }, `folder:adding`);
        case `copying`:
            if (folder.status === `paused`) {
                return card(
                    {
                        about: `folder`,
                        tone: `waiting`,
                        stage: `lit`,
                        title: t(`local.machine.folder.paused`, { name }),
                        detail: t(`local.machine.folder.pausedDetail`),
                        actions: [`open`],
                    },
                    `folder:paused`,
                );
            }
            return card(
                {
                    about: `folder`,
                    tone: `working`,
                    stage: `moving`,
                    title: t(`local.machine.folder.copying`, { name }),
                    // No word from the copy yet: the sandbox has not taken the folder's first report.
                    detail: folder.status === undefined ? t(`local.machine.folder.preparing`) : t(`local.machine.folder.copyingDetail`),
                    actions: [],
                },
                `folder:copying`,
            );
        case `failed`:
            return card(
                { about: `folder`, tone: `failed`, stage: `lit`, title: t(`local.machine.folder.failed`, { name }), detail: folder.reason, actions: [`retryFolder`] },
                `folder:failed`,
            );
        case `ready`:
            return justIn
                ? card(
                      {
                          about: `folder`,
                          tone: `ready`,
                          stage: `home`,
                          title: t(`local.machine.folder.ready`, { name }),
                          detail: t(`local.machine.folder.readyDetail`),
                          short: t(`local.machine.folder.readyShort`, { name }),
                          actions: [`open`],
                      },
                      `folder:ready`,
                  )
                : undefined;
        default:
            return undefined;
    }
};

// Before the sandbox: nobody signed in, the reader in the browser signing in, or just back from it.
const accountCard = (machine: LocalMachineSandbox, folder: LocalFolderSandbox | undefined, signingIn: boolean): MachineCard | undefined => {
    // Back from the browser, the account on its way to the app: the sign-in is done, and the sandbox is next.
    if (machine.state === `signedIn`) {
        return card(
            { about: `machine`, tone: `working`, stage: `plan`, title: t(`local.machine.signedIn`), detail: t(`local.machine.signedInDetail`), actions: [] },
            `signedIn`,
        );
    }
    // Sent to the browser from here: the card says to finish there, not to sign in again, and stays on its way through
    // the moment after, before the app has heard who signed in (2026-10-17: it said "Sign in" all along).
    if (signingIn) {
        return card(
            { about: `machine`, tone: `working`, stage: `plan`, title: t(`local.machine.signingIn`), detail: t(`local.machine.signingInDetail`), actions: [`signInAgain`] },
            `signingIn`,
        );
    }
    // Nothing is under way before sign-in: said only to a reader whose folder waits for it.
    return machine.waiting > 0 || folder?.state === `queued`
        ? card(
              { about: `machine`, tone: `waiting`, stage: `plan`, title: t(`local.machine.signedOut`), detail: t(`local.machine.signedOutDetail`), actions: [`signIn`] },
              `signedOut`,
          )
        : undefined;
};

// A sandbox made already whose container is stopped, or being started: the house stands with its lights off. A folder
// waiting starts it by itself (the app's machine_sandbox.rs `starts_by_itself`), so the card asks only when nothing
// waits for it, or its start failed.
const powerCard = (machine: LocalMachineSandbox): MachineCard | undefined => {
    if (machine.state === `starting`) {
        return card(
            { about: `machine`, tone: `working`, stage: `roof`, title: t(`local.machine.starting`), detail: t(`local.machine.startingDetail`), actions: [] },
            `starting`,
        );
    }
    if (machine.state !== `stopped`) {
        return undefined;
    }
    return machine.reason === undefined
        ? card({ about: `machine`, tone: `waiting`, stage: `roof`, title: t(`local.machine.stopped`), detail: t(`local.machine.stoppedDetail`), actions: [`start`] }, `stopped`)
        : card({ about: `machine`, tone: `failed`, stage: `roof`, title: t(`local.machine.startFailed`), detail: machine.reason, actions: [`start`] }, `startFailed`);
};

// The setup's own stops: Docker, a question for This computer, a failure.
const setupStopCard = (machine: LocalMachineSandbox & { readonly state: `needsDocker` | `waiting` | `failed` }): MachineCard => {
    switch (machine.state) {
        case `needsDocker`:
            return card(
                {
                    about: `machine`,
                    tone: `waiting`,
                    stage: `plan`,
                    title: t(`local.machine.needsDocker.${machine.reason}`),
                    detail: t(`local.machine.needsDockerDetail.${machine.reason}`),
                    // Docker is started on the reader's press, never by itself; anything more is on This computer.
                    actions: machine.reason === `notRunning` ? [`startDocker`, `details`] : [`details`],
                },
                `needsDocker:${machine.reason}`,
            );
        case `waiting`:
            return card(
                { about: `machine`, tone: `waiting`, stage: `plan`, title: t(`local.machine.waiting`), detail: t(`local.machine.waitingDetail.${machine.for}`), actions: [`details`] },
                `waiting`,
            );
        case `failed`:
            return card(
                {
                    about: `machine`,
                    tone: `failed`,
                    stage: `plan`,
                    title: t(`local.machine.failed`),
                    detail: machine.reason,
                    actions: machine.hasLog ? [`retry`, `log`] : [`retry`],
                },
                `failed`,
            );
    }
};

// This computer's sandbox while it is not ready, and for a moment once it is.
const sandboxCard = (machine: LocalMachineSandbox, folder: LocalFolderSandbox | undefined, justReady: boolean, signingIn = false): MachineCard | undefined => {
    switch (machine.state) {
        case `ready`:
            return justReady
                ? card({ about: `machine`, tone: `ready`, stage: MACHINE_TOP, title: t(`local.machine.ready`), detail: t(`local.machine.readyDetail`), actions: [] }, `ready`)
                : undefined;
        case `signedIn`:
        case `signedOut`:
            return accountCard(machine, folder, signingIn);
        case `needsDocker`:
        case `waiting`:
        case `failed`:
            return setupStopCard(machine);
        case `creating`: {
            const stage = machineStage(machine.phase);
            return card(
                {
                    about: `machine`,
                    tone: `working`,
                    stage,
                    title: t(`local.machine.creating`),
                    detail: stageHeadline(stage),
                    percent: machine.percent,
                    step: machine.step,
                    short: t(`local.machine.creatingShort`),
                    actions: [],
                },
                `creating`,
            );
        }
        case `interrupted`:
            return card(
                { about: `machine`, tone: `working`, stage: `plan`, title: t(`local.machine.interrupted`), detail: t(`local.machine.interruptedDetail`), actions: [] },
                `creating`,
            );
        case `stopped`:
        case `starting`:
            return powerCard(machine);
        case `gone`:
            return card({ about: `machine`, tone: `failed`, stage: `plan`, title: t(`local.machine.gone`), detail: t(`local.machine.goneDetail`), actions: [`recreate`] }, `gone`);
    }
};

// The card's own, before this window's folder's steps are added to it.
const bareCardOf = (facts: CardFacts, machine: LocalMachineSandbox): MachineCard | undefined => {
    const { folder } = facts;
    if (machine.state === `ready` && folder !== undefined) {
        const own = folderCard(folder, facts.folderJustReady);
        if (own !== undefined) {
            return own;
        }
    }
    return sandboxCard(machine, folder, facts.justReady, facts.signingIn);
};

/** The card this window carries, or none: its folder's own once the sandbox is up, else this computer's sandbox's. */
export const machineCardOf = (facts: CardFacts): MachineCard | undefined => {
    const { machine, folder } = facts;
    if (machine === undefined) {
        return undefined;
    }
    const shown = bareCardOf(facts, machine);
    if (shown === undefined) {
        return undefined;
    }
    // The house is the sandbox: nothing of it is under way while the reader is still to sign in.
    const picture = machine.state !== `signedOut`;
    // This window's folder on its way in: the card ticks off its steps, which say where it waits as well.
    const onItsWay = folder !== undefined && (folder.state !== `ready` || facts.folderJustReady);
    if (!onItsWay) {
        return { ...shown, picture };
    }
    const steps = journeyOf({
        machine,
        folder,
        name: folder.name,
        signingIn: facts.signingIn === true,
        withSignIn: facts.withSignIn === true || machine.state === `signedOut` || machine.state === `signedIn`,
    });
    return { ...shown, picture, steps };
};

/**
 * The folder's own button: what it says, and what a press does — ask the dialog, open its sandbox, unfold the card, or
 * the one thing the sandbox is stopped on. `open` here and on the card opens the folder's own sandbox. A paused copy
 * unfolds the card, which offers that sandbox so the reader can manage its file syncing.
 */
export interface FolderButton {
    readonly label: string;
    /** The folder is on its way in: the button says how far rather than what it does. */
    readonly busy: boolean;
    readonly press: `ask` | `open` | `card` | MachineCardAction;
}

// The card's verbs, as the folder's own button says them. A press that goes to This computer is named by what it is FOR
// there, because this button is the window's one way on, with nothing above it to explain itself: "Open This computer"
// is a destination, and what the reader needs is the sentence that says this computer isn't ready for agents yet.
const pressLabel = (action: MachineCardAction): string =>
    action === `details` ? t(`local.machine.button.setUpComputer`) : t(`local.machine.action.${action === `retryFolder` ? `retry` : action}`);

// The folder on its way in, not there yet: what its button says about how far, or the one step it is stopped on.
const onItsWayButton = (machine: LocalMachineSandbox | undefined, folder: LocalFolderSandbox, signingIn: boolean): FolderButton => {
    // On its way through the browser's sign-in: the button says where the reader's part of it is.
    if (machine?.state === `signedOut` && signingIn) {
        return { label: t(`local.machine.button.signingIn`), busy: true, press: `card` };
    }
    // Signed in and the account on its way, or a stopped sandbox starting for it: what is under way, by name.
    if (machine?.state === `signedIn` || machine?.state === `starting`) {
        return { label: t(`local.machine.button.${machine.state}`), busy: true, press: `card` };
    }
    if (machine?.state === `ready`) {
        if (folder.status === `paused`) {
            return { label: t(`local.machine.button.paused`), busy: false, press: `card` };
        }
        return { label: t(`local.machine.button.copying`), busy: true, press: `card` };
    }
    // The sandbox stopped on something only the reader can do (this PC's own setup, Docker, a sign-in): the button IS
    // that thing. It used to say it was waiting and, on a press, unfold a card that was already on screen — a word that
    // blamed the machine for a wait that was the reader's, and a press that did nothing.
    const stop = machine === undefined ? undefined : sandboxCard(machine, folder, false);
    const next = stop === undefined || stop.tone === `working` ? undefined : stop.actions[0];
    if (next !== undefined) {
        return { label: pressLabel(next), busy: false, press: next };
    }
    // Under way with nothing to ask of anyone: how far it is, and the card for the rest.
    return {
        label: machine?.state === `creating` ? t(`local.machine.button.waitingPercent`, { percent: machine.percent }) : t(`local.machine.button.waiting`),
        busy: true,
        press: `card`,
    };
};

export const folderButtonOf = (facts: {
    readonly hasSandbox: boolean;
    readonly machine: LocalMachineSandbox | undefined;
    readonly folder: LocalFolderSandbox | undefined;
    /** The reader is signing in, in the browser, from this window (useLocalProject.ts). */
    readonly signingIn?: boolean;
}): FolderButton => {
    const { machine, folder } = facts;
    if (folder?.state === `failed`) {
        return { label: t(`local.machine.button.failed`), busy: false, press: `card` };
    }
    if (folder !== undefined && folder.state !== `ready`) {
        return onItsWayButton(machine, folder, facts.signingIn === true);
    }
    if (facts.hasSandbox || folder?.state === `ready`) {
        return { label: t(`local.localFiles.openSandbox`), busy: false, press: `open` };
    }
    return { label: t(`local.localFiles.withAgent`), busy: false, press: `ask` };
};
