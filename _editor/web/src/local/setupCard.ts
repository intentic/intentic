import { t } from "@intentic/ui/i18n";
import type { LocalFolderSetup } from "../app/environments/localHost";
import { type HouseStage, houseStageOf } from "./house/agentHouse";
import { type JourneyStep, journeyOf } from "./journey/journey";
import { stageHeadline } from "./projectWords";

// WHAT A LOCAL WINDOW SAYS ABOUT ITS FOLDER'S OWN SANDBOX: the card in the window's corner (LocalSetupCard.vue) and the
// folder's own button (LocalFiles.vue), read off what the app says (its folder_setup.rs, through the host). The card
// is there while the folder is on its way to its sandbox, and for a moment once it is in. Pure, so every state's words
// and buttons are tested by value (setupCard.test.ts).
//
// (2026-10-21) Every window used to carry a card about the one sandbox the app made for the whole computer, which every
// folder was attached to; a folder now becomes a sandbox of its own, and its window speaks of that one alone.

/** What the card's buttons do. */
export type SetupCardAction =
    // The app's own verbs (the host's `act`).
    | `signIn`
    // The same sign-in, its page opened again: the reader was sent to the browser already, and may have lost the tab.
    | `signInAgain`
    | `startDocker`
    | `retry`
    | `consent`
    | `restart`
    | `signOut`
    | `log`
    | `dismiss`
    // This computer's page, where anything with more than a button to it is drawn (Docker, this PC's own setup).
    | `details`
    // The folder's sandbox, opened on the folder.
    | `open`;

export interface SetupCard {
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
    readonly actions: readonly SetupCardAction[];
    /** What the card is showing, for remembering it was folded: a new state unfolds it again. */
    readonly key: string;
    /** The folder's way to an agent, step by step (journey.ts): the sign-in, the sandbox, the copy. */
    readonly steps: readonly JourneyStep[];
    /**
     * Whether the agent's house is drawn: not while the reader is still to sign in, when nothing of the sandbox is under
     * way and the picture would show a house going up and a folder carried into it for a press that only signs in.
     */
    readonly picture: boolean;
}

export interface CardFacts {
    readonly setup: LocalFolderSetup | undefined;
    /** The folder's sandbox finished taking it in moments ago, while this window watched. */
    readonly justReady: boolean;
    /** This window sent the reader to the browser to sign in, and the app has not heard who signed in yet. */
    readonly signingIn?: boolean;
    /** The sign-in is a step of this folder's way: nobody was signed in when it was asked for. */
    readonly withSignIn?: boolean;
}

type Draft = Omit<SetupCard, `short` | `key` | `percent` | `step` | `steps` | `picture` | `stage`> &
    Partial<Pick<SetupCard, `short` | `percent` | `step` | `stage`>>;

// Why a paused copy waits, by the machine agent's first hold: the reader's own pause, which the sandbox's Devices page
// lifts, or one that passes by itself, which no press of the reader's can (2026-10-20).
const heldDetail = (heldBy: readonly string[]): string => {
    switch (heldBy[0]) {
        case `low-disk`:
            return t(`local.setup.heldLowDisk`);
        case `swap`:
            return t(`local.setup.heldSwap`);
        case `unreachable`:
            return t(`local.setup.heldUnreachable`);
        case `gone`:
        case `container-missing`:
        case `container-trashed`:
            return t(`local.setup.heldAway`);
        default:
            return t(`local.setup.pausedDetail`);
    }
};

// Before the sandbox: nobody signed in, the reader in the browser signing in, or just back from it.
const accountDraft = (setup: LocalFolderSetup, signingIn: boolean): [Draft, string] => {
    const name = setup.name;
    if (setup.state === `signedIn`) {
        return [{ tone: `working`, stage: `plan`, title: t(`local.setup.signedIn`), detail: t(`local.setup.signedInDetail`, { name }), actions: [] }, `signedIn`];
    }
    // Sent to the browser from here: the card says to finish there, not to sign in again (2026-10-17).
    if (signingIn) {
        return [{ tone: `working`, stage: `plan`, title: t(`local.setup.signingIn`), detail: t(`local.setup.signingInDetail`), actions: [`signInAgain`] }, `signingIn`];
    }
    return [{ tone: `waiting`, stage: `plan`, title: t(`local.setup.signedOut`, { name }), detail: t(`local.setup.signedOutDetail`), actions: [`signIn`, `dismiss`] }, `signedOut`];
};

// What this computer needs first, and the press for it: this PC's own setup (Devices), a yes to what the setup's
// first pass found, or the restart or sign-out Windows wants.
const waitingDraft = (setup: LocalFolderSetup & { readonly state: `waiting` }): Draft => {
    const name = setup.name;
    const title = t(`local.setup.waiting`, { name });
    switch (setup.for) {
        case `restart`:
            return { tone: `waiting`, title, detail: t(`local.setup.waitingDetail.restart`), actions: [`restart`, `dismiss`] };
        case `signOut`:
            return { tone: `waiting`, title, detail: t(`local.setup.waitingDetail.signOut`), actions: [`signOut`, `dismiss`] };
        case `consent`:
            return setup.needs.length === 0
                ? { tone: `waiting`, title, detail: t(`local.setup.waitingDetail.consent`), actions: [`details`, `dismiss`] }
                : { tone: `waiting`, title, detail: t(`local.setup.waitingDetail.needs`, { needs: setup.needs.join(`, `) }), actions: [`consent`, `dismiss`] };
    }
};

// The card's own words for each state, and the key its fold is remembered under.
const draftOf = (setup: LocalFolderSetup, justReady: boolean, signingIn: boolean): [Draft, string] | undefined => {
    const name = setup.name;
    switch (setup.state) {
        case `signedOut`:
        case `signedIn`:
            return accountDraft(setup, signingIn);
        case `queued`:
            return setup.behind === undefined
                ? [{ tone: `working`, stage: `plan`, title: t(`local.setup.queued`, { name }), detail: t(`local.setup.queuedDetail`), actions: [] }, `queued`]
                : [
                      {
                          tone: `working`,
                          stage: `plan`,
                          title: t(`local.setup.behind`, { behind: setup.behind }),
                          detail: t(`local.setup.behindDetail`, { name }),
                          actions: [`dismiss`],
                      },
                      `behind`,
                  ];
        case `needsDocker`:
            return [
                {
                    tone: `waiting`,
                    stage: `plan`,
                    title: t(`local.setup.needsDocker.${setup.reason}`, { name }),
                    detail: t(`local.setup.needsDockerDetail.${setup.reason}`),
                    // Docker is started on the reader's press, never by itself; anything more is on This computer.
                    actions: setup.reason === `notRunning` ? [`startDocker`, `details`] : [`details`, `dismiss`],
                },
                `needsDocker:${setup.reason}`,
            ];
        case `waiting`:
            return [{ stage: `plan`, ...waitingDraft(setup) }, `waiting:${setup.for}`];
        case `creating`: {
            const stage = houseStageOf({ state: setup.state, phase: setup.phase });
            return [
                {
                    tone: `working`,
                    stage,
                    title: t(`local.setup.creating`, { name }),
                    detail: stageHeadline(stage),
                    percent: setup.percent,
                    step: setup.step,
                    short: t(`local.setup.creatingShort`, { name }),
                    actions: [],
                },
                `creating`,
            ];
        }
        case `interrupted`:
            return [{ tone: `working`, stage: `plan`, title: t(`local.setup.interrupted`, { name }), detail: t(`local.setup.interruptedDetail`), actions: [] }, `creating`];
        case `copying`:
            if (setup.status === `paused`) {
                return [{ tone: `waiting`, stage: `lit`, title: t(`local.setup.paused`, { name }), detail: heldDetail(setup.heldBy), actions: [`open`] }, `paused`];
            }
            return [
                {
                    tone: `working`,
                    stage: `moving`,
                    title: t(`local.setup.copying`, { name }),
                    // No word from the copy yet: the sandbox has not taken the folder's first report.
                    detail: setup.status === undefined ? t(`local.setup.preparing`) : t(`local.setup.copyingDetail`),
                    actions: [],
                },
                `copying`,
            ];
        case `failed`:
            // Made, and the folder never started syncing: the sandbox is there to open and look at.
            return setup.made
                ? [{ tone: `failed`, stage: `lit`, title: t(`local.setup.noSync`, { name }), detail: setup.reason, actions: [`open`, `dismiss`] }, `noSync`]
                : [
                      {
                          tone: `failed`,
                          stage: `plan`,
                          title: t(`local.setup.failed`, { name }),
                          detail: setup.reason,
                          actions: setup.hasLog ? [`retry`, `log`, `dismiss`] : [`retry`, `dismiss`],
                      },
                      `failed`,
                  ];
        case `ready`:
            return justReady
                ? [
                      {
                          tone: `ready`,
                          stage: `home`,
                          title: t(`local.setup.ready`, { name }),
                          detail: t(`local.setup.readyDetail`),
                          short: t(`local.setup.readyShort`, { name }),
                          actions: [`open`],
                      },
                      `ready`,
                  ]
                : undefined;
    }
};

/** The card this window carries, or none: its folder's own sandbox on its way, and a moment once the folder is in. */
export const setupCardOf = (facts: CardFacts): SetupCard | undefined => {
    const { setup } = facts;
    if (setup === undefined) {
        return undefined;
    }
    const drafted = draftOf(setup, facts.justReady, facts.signingIn === true);
    if (drafted === undefined) {
        return undefined;
    }
    const [draft, key] = drafted;
    const steps = journeyOf({
        setup,
        signedIn: setup.state !== `signedOut`,
        name: setup.name,
        signingIn: facts.signingIn === true,
        withSignIn: facts.withSignIn === true || setup.state === `signedOut` || setup.state === `signedIn`,
    });
    return {
        percent: undefined,
        step: undefined,
        short: draft.title,
        stage: `plan`,
        ...draft,
        key,
        steps,
        // The house is the sandbox: nothing of it is under way while the reader is still to sign in.
        picture: setup.state !== `signedOut`,
    };
};

/**
 * The folder's own button: what it says, and what a press does — ask the dialog, open its sandbox, unfold the card, or
 * the one thing its setup is stopped on.
 */
export interface FolderButton {
    readonly label: string;
    /** The folder is on its way: the button says how far rather than what it does. */
    readonly busy: boolean;
    readonly press: `ask` | `open` | `card` | SetupCardAction;
}

// The card's verbs, as the folder's own button says them. A press that goes to This computer is named by what it is FOR
// there, because this button is the window's one way on, with nothing above it to explain itself.
const pressLabel = (action: SetupCardAction): string => (action === `details` ? t(`local.setup.button.setUpComputer`) : t(`local.setup.action.${action}`));

// The folder on its way, not in yet: what its button says about how far, or the one step it is stopped on.
const onItsWayButton = (setup: LocalFolderSetup, signingIn: boolean): FolderButton => {
    switch (setup.state) {
        case `signedOut`:
            return signingIn ? { label: t(`local.setup.button.signingIn`), busy: true, press: `card` } : { label: pressLabel(`signIn`), busy: false, press: `signIn` };
        case `signedIn`:
            return { label: t(`local.setup.button.signedIn`), busy: true, press: `card` };
        case `queued`:
            return setup.behind === undefined
                ? { label: t(`local.setup.button.waiting`), busy: true, press: `card` }
                : { label: t(`local.setup.button.behind`), busy: true, press: `card` };
        case `creating`:
            return { label: t(`local.setup.button.waitingPercent`, { percent: setup.percent }), busy: true, press: `card` };
        case `interrupted`:
            return { label: t(`local.setup.button.waiting`), busy: true, press: `card` };
        case `copying`:
            return setup.status === `paused`
                ? { label: t(`local.setup.button.paused`), busy: false, press: `card` }
                : { label: t(`local.setup.button.copying`), busy: true, press: `card` };
        case `failed`:
            return { label: t(`local.setup.button.failed`), busy: false, press: `card` };
        case `needsDocker`:
        case `waiting`: {
            // Stopped on something only the reader can do (this PC's own setup, Docker): the button IS that thing.
            const next = draftOf(setup, false, signingIn)?.[0].actions[0];
            return next === undefined || next === `dismiss` ? { label: t(`local.setup.button.waiting`), busy: false, press: `card` } : { label: pressLabel(next), busy: false, press: next };
        }
        case `ready`:
            return { label: t(`local.localFiles.openSandbox`), busy: false, press: `open` };
    }
};

export const folderButtonOf = (facts: {
    readonly hasSandbox: boolean;
    readonly setup: LocalFolderSetup | undefined;
    /** The reader is signing in, in the browser, from this window (useLocalProject.ts). */
    readonly signingIn?: boolean;
}): FolderButton => {
    const { setup } = facts;
    if (setup !== undefined && setup.state !== `ready`) {
        return onItsWayButton(setup, facts.signingIn === true);
    }
    if (facts.hasSandbox || setup?.state === `ready`) {
        return { label: t(`local.localFiles.openSandbox`), busy: false, press: `open` };
    }
    return { label: t(`local.localFiles.withAgent`), busy: false, press: `ask` };
};
