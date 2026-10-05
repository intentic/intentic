import { t } from "@intentic/ui/i18n";
import type { LocalFolderSandbox, LocalMachineSandbox } from "../app/environments/localHost";
import { HOUSE_STAGES, type HouseStage, stageOfPhase } from "./agentHouse";
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
    /** This window's folder, waiting for it. */
    readonly folderNote: string | undefined;
    /** The card folded to one line. */
    readonly short: string;
    /** The first is the primary press. */
    readonly actions: readonly MachineCardAction[];
    /** What the card is showing, for remembering it was folded: a new state unfolds it again. */
    readonly key: string;
}

export interface CardFacts {
    readonly machine: LocalMachineSandbox | undefined;
    readonly folder: LocalFolderSandbox | undefined;
    /** This computer's sandbox became ready moments ago, while this window watched. */
    readonly justReady: boolean;
    /** This window's folder finished going in moments ago, while this window watched. */
    readonly folderJustReady: boolean;
}

// The house of this computer's sandbox stands with its lights on once it answers: moving in is a folder's own copy.
const MACHINE_TOP: HouseStage = `lit`;
const machineStage = (phase: string | undefined): HouseStage => {
    const stage = stageOfPhase(phase);
    return HOUSE_STAGES.indexOf(stage) > HOUSE_STAGES.indexOf(MACHINE_TOP) ? MACHINE_TOP : stage;
};

type Draft = Omit<MachineCard, `short` | `key` | `folderNote` | `percent` | `step`> &
    Partial<Pick<MachineCard, `short` | `percent` | `step` | `folderNote`>>;

const card = (draft: Draft, key: string): MachineCard => ({
    percent: undefined,
    step: undefined,
    folderNote: undefined,
    short: draft.title,
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

// This computer's sandbox while it is not ready, and for a moment once it is.
const sandboxCard = (machine: LocalMachineSandbox, folder: LocalFolderSandbox | undefined, justReady: boolean): MachineCard | undefined => {
    switch (machine.state) {
        case `ready`:
            return justReady
                ? card({ about: `machine`, tone: `ready`, stage: MACHINE_TOP, title: t(`local.machine.ready`), detail: t(`local.machine.readyDetail`), actions: [] }, `ready`)
                : undefined;
        case `signedOut`:
            // Nothing is under way before sign-in: said only to a reader whose folder waits for it.
            return machine.waiting > 0 || folder?.state === `queued`
                ? card(
                      {
                          about: `machine`,
                          tone: `waiting`,
                          stage: `plan`,
                          title: t(`local.machine.signedOut`),
                          detail: t(`local.machine.signedOutDetail`),
                          actions: [`signIn`],
                      },
                      `signedOut`,
                  )
                : undefined;
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
        case `stopped`:
            return card({ about: `machine`, tone: `waiting`, stage: MACHINE_TOP, title: t(`local.machine.stopped`), detail: t(`local.machine.stoppedDetail`), actions: [`start`] }, `stopped`);
        case `gone`:
            return card({ about: `machine`, tone: `failed`, stage: `plan`, title: t(`local.machine.gone`), detail: t(`local.machine.goneDetail`), actions: [`recreate`] }, `gone`);
        default:
            return undefined;
    }
};

/** The card this window carries, or none: its folder's own once the sandbox is up, else this computer's sandbox's. */
export const machineCardOf = (facts: CardFacts): MachineCard | undefined => {
    const { machine, folder } = facts;
    if (machine === undefined) {
        return undefined;
    }
    if (machine.state === `ready` && folder !== undefined) {
        const own = folderCard(folder, facts.folderJustReady);
        if (own !== undefined) {
            return own;
        }
    }
    const shown = sandboxCard(machine, folder, facts.justReady);
    // A folder waiting for it says so under whatever the sandbox is doing.
    return shown !== undefined && folder?.state === `queued` && machine.state !== `ready`
        ? { ...shown, folderNote: t(`local.machine.folderWaits`, { name: folder.name }) }
        : shown;
};

/** The folder's own button: what it says, and what a press does (ask the dialog, open its sandbox, unfold the card). */
export interface FolderButton {
    readonly label: string;
    /** The folder is on its way in: the button says how far rather than what it does. */
    readonly busy: boolean;
    readonly press: `ask` | `open` | `card`;
}

export const folderButtonOf = (facts: {
    readonly hasSandbox: boolean;
    readonly machine: LocalMachineSandbox | undefined;
    readonly folder: LocalFolderSandbox | undefined;
}): FolderButton => {
    const { machine, folder } = facts;
    if (folder?.state === `failed`) {
        return { label: t(`local.machine.button.failed`), busy: false, press: `card` };
    }
    if (folder !== undefined && folder.state !== `ready`) {
        if (machine?.state !== `ready`) {
            return {
                label:
                    machine?.state === `creating`
                        ? t(`local.machine.button.waitingPercent`, { percent: machine.percent })
                        : t(`local.machine.button.waiting`),
                busy: true,
                press: `card`,
            };
        }
        return { label: t(`local.machine.button.copying`), busy: true, press: `card` };
    }
    if (facts.hasSandbox || folder?.state === `ready`) {
        return { label: t(`local.localFiles.openSandbox`), busy: false, press: `open` };
    }
    return { label: t(`local.localFiles.withAgent`), busy: false, press: `ask` };
};
