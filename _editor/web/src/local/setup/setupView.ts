import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { LocalFolderSetup, LocalProjectPreview } from "../../app/environments/localHost";
import { type HouseStage, houseStageOf } from "../house/agentHouse";
import { activeStep, type JourneyStep, journeyOf } from "../journey/journey";
import { refusalSentence, stageHeadline } from "../projectWords";

// A FOLDER'S WAY TO AN AGENT, AS A PAGE OF ITS OWN (LocalSandboxSetup.vue): what the page says before the press (what
// the folder's sandbox involves), and at every step after it (the sign-in, the sandbox being made, the folder's copy,
// done), read off what the app says (its folder_setup.rs, through the host). Also the rail tile's mark while the page
// is out of sight, and the folder's own button in Files. Pure, so every state's words and presses are tested by value
// (setupView.test.ts).
//
// (2026-10-21) This replaced a dialog that went away on the press and a card in the window's corner that could not be
// put away. The card showed no measure of progress, no estimate and little of what was going on, and took a sign-in
// that had already happened for none. One page now holds the whole way, from the ask to the open sandbox. The reader
// can leave it for Files and come back from its tile on the rail.

/** What the page's buttons do. */
export type SetupPress =
    // The page's own ask: make the folder's sandbox, signing in first where nobody is.
    | `create`
    | `signInCreate`
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

/** How it is going: the reader's to start, under way, waiting on the reader, done, or stopped short. */
export type SetupTone = `asking` | `working` | `waiting` | `ready` | `failed`;

/** The page's picture: the agent's house as far as it stands, or a mark for a step with no house to it (the sign-in). */
export type SetupHero = { readonly kind: `house`; readonly stage: HouseStage } | { readonly kind: `mark`; readonly icon: IconName };

export interface SetupView {
    readonly tone: SetupTone;
    readonly hero: SetupHero;
    readonly title: string;
    readonly detail: string | undefined;
    /** How far the sandbox's setup is, where it is measured. */
    readonly percent: number | undefined;
    /** The setup's running step, in its own words. */
    readonly step: string | undefined;
    /** Roughly how many seconds are left, by the setup's plan. */
    readonly left: number | undefined;
    /** The folder's way to an agent, step by step (journey.ts): the sign-in, the sandbox, the copy. */
    readonly steps: readonly JourneyStep[];
    /** The first is the primary press. */
    readonly actions: readonly SetupPress[];
    /** Nothing here waits on the reader: they can leave the page, and the work carries on without them. */
    readonly carriesOn: boolean;
}

export interface SetupFacts {
    readonly setup: LocalFolderSetup | undefined;
    /** What the app said about the folder before the press (project.rs `project_preview`); undefined while it weighs it. */
    readonly preview: LocalProjectPreview | undefined;
    /** The folder's own name and path, known before the app has weighed it. */
    readonly name: string;
    readonly path: string;
    /** This window sent the reader to the browser to sign in, and the app has not heard who signed in yet. */
    readonly signingIn?: boolean;
    /** The sign-in is a step of this folder's way: nobody was signed in when it was asked for. */
    readonly withSignIn?: boolean;
}

type Draft = Pick<SetupView, `tone` | `hero` | `title` | `detail` | `actions`> & Partial<Pick<SetupView, `percent` | `step` | `left`>>;

const house = (stage: HouseStage): SetupHero => ({ kind: `house`, stage });
const SIGN_IN: SetupHero = { kind: `mark`, icon: `sign-in` };

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
const accountDraft = (setup: LocalFolderSetup, signingIn: boolean): Draft => {
    const name = setup.name;
    if (setup.state === `signedIn`) {
        return { tone: `working`, hero: house(`plan`), title: t(`local.setup.signedIn`), detail: t(`local.setup.signedInDetail`, { name }), actions: [] };
    }
    // Sent to the browser from here: the page says to finish there, not to sign in again (2026-10-17).
    if (signingIn) {
        return { tone: `working`, hero: SIGN_IN, title: t(`local.setup.signingIn`), detail: t(`local.setup.signingInDetail`), actions: [`signInAgain`, `dismiss`] };
    }
    return { tone: `asking`, hero: SIGN_IN, title: t(`local.setup.signInFirst`), detail: t(`local.setup.signInFirstDetail`, { name }), actions: [`signIn`, `dismiss`] };
};

// What this computer needs first, and the press for it: this PC's own setup (Devices), a yes to what the setup's
// first pass found, or the restart or sign-out Windows wants.
const waitingDraft = (setup: LocalFolderSetup & { readonly state: `waiting` }): Draft => {
    const base = { tone: `waiting`, hero: house(`plan`), title: t(`local.setup.waiting`, { name: setup.name }) } as const;
    switch (setup.for) {
        case `restart`:
            return { ...base, detail: t(`local.setup.waitingDetail.restart`), actions: [`restart`, `dismiss`] };
        case `signOut`:
            return { ...base, detail: t(`local.setup.waitingDetail.signOut`), actions: [`signOut`, `dismiss`] };
        case `consent`:
            return setup.needs.length === 0
                ? { ...base, detail: t(`local.setup.waitingDetail.consent`), actions: [`details`, `dismiss`] }
                : { ...base, detail: t(`local.setup.waitingDetail.needs`, { needs: setup.needs.join(`, `) }), actions: [`consent`, `dismiss`] };
    }
};

// The copy under way, or held still.
const copyingDraft = (setup: LocalFolderSetup): Draft => {
    const name = setup.name;
    if (setup.status === `paused`) {
        return { tone: `waiting`, hero: house(`lit`), title: t(`local.setup.paused`, { name }), detail: heldDetail(setup.heldBy), actions: [`open`] };
    }
    // No word from the copy yet: the sandbox has not taken the folder's first report.
    const detail = setup.status === undefined ? t(`local.setup.preparing`) : t(`local.setup.copyingDetail`);
    return { tone: `working`, hero: house(`moving`), title: t(`local.setup.copying`, { name }), detail, actions: [] };
};

// The page's own words for each state of the folder's setup.
const draftOf = (setup: LocalFolderSetup, signingIn: boolean): Draft => {
    const name = setup.name;
    switch (setup.state) {
        case `signedOut`:
        case `signedIn`:
            return accountDraft(setup, signingIn);
        case `queued`:
            return setup.behind === undefined
                ? { tone: `working`, hero: house(`plan`), title: t(`local.setup.queued`, { name }), detail: t(`local.setup.queuedDetail`), actions: [] }
                : {
                      tone: `working`,
                      hero: house(`plan`),
                      title: t(`local.setup.behind`, { behind: setup.behind }),
                      detail: t(`local.setup.behindDetail`, { name }),
                      actions: [`dismiss`],
                  };
        case `needsDocker`:
            return {
                tone: `waiting`,
                hero: house(`plan`),
                title: t(`local.setup.needsDocker.${setup.reason}`, { name }),
                detail: t(`local.setup.needsDockerDetail.${setup.reason}`),
                // Docker is started on the reader's press, never by itself; anything more is on Devices.
                actions: setup.reason === `notRunning` ? [`startDocker`, `details`] : [`details`, `dismiss`],
            };
        case `waiting`:
            return waitingDraft(setup);
        case `creating`: {
            const stage = houseStageOf({ state: setup.state, phase: setup.phase });
            return {
                tone: `working`,
                hero: house(stage),
                title: t(`local.setup.creating`, { name }),
                detail: stageHeadline(stage),
                percent: setup.percent,
                step: setup.step,
                left: setup.left,
                actions: [],
            };
        }
        case `interrupted`:
            return { tone: `working`, hero: house(`plan`), title: t(`local.setup.interrupted`, { name }), detail: t(`local.setup.interruptedDetail`), actions: [] };
        case `copying`:
            return copyingDraft(setup);
        case `failed`:
            // Made, and the folder never started syncing: the sandbox is there to open and look at.
            return setup.made
                ? { tone: `failed`, hero: house(`lit`), title: t(`local.setup.noSync`, { name }), detail: setup.reason, actions: [`open`, `dismiss`] }
                : {
                      tone: `failed`,
                      hero: house(`plan`),
                      title: t(`local.setup.failed`, { name }),
                      detail: setup.reason,
                      actions: setup.hasLog ? [`retry`, `log`, `dismiss`] : [`retry`, `dismiss`],
                  };
        case `ready`:
            return { tone: `ready`, hero: house(`home`), title: t(`local.setup.ready`, { name }), detail: t(`local.setup.readyDetail`), actions: [`open`] };
    }
};

// Before the press: what a sandbox of the folder's own involves, or why the folder cannot have one.
const askDraft = (preview: LocalProjectPreview, facts: SetupFacts): Draft | undefined => {
    switch (preview.kind) {
        case `existing`:
            return undefined;
        case `document`:
            return { tone: `failed`, hero: house(`plan`), title: t(`local.project.documentTitle`), detail: t(`local.project.document`), actions: [] };
        case `refused`:
            return {
                tone: `failed`,
                hero: house(`plan`),
                title: t(`local.project.refusedTitle`),
                detail: refusalSentence(preview.refusal, facts.path),
                actions: [],
            };
        case `new`:
            return {
                tone: `asking`,
                hero: house(`plan`),
                title: t(`local.project.dialogTitle`, { name: preview.name }),
                detail: t(`local.project.lede`),
                actions: [preview.signedIn ? `create` : `signInCreate`],
            };
    }
};

/**
 * What the page says: the folder's setup wherever it stands, or before the press, the ask. Undefined while there is
 * nothing to say yet (the app still weighing the folder) and for a folder that has its sandbox already, which is opened.
 */
export const setupViewOf = (facts: SetupFacts): SetupView | undefined => {
    const { setup, preview } = facts;
    const signingIn = facts.signingIn === true;
    if (setup === undefined) {
        const asked = preview === undefined ? undefined : askDraft(preview, facts);
        if (asked === undefined || preview?.kind !== `new`) {
            return asked === undefined ? undefined : { percent: undefined, step: undefined, left: undefined, ...asked, steps: [], carriesOn: false };
        }
        const steps = journeyOf({ setup: undefined, signedIn: preview.signedIn, name: preview.name, signingIn: false, withSignIn: !preview.signedIn });
        return { percent: undefined, step: undefined, left: undefined, ...asked, steps, carriesOn: false };
    }
    const draft = draftOf(setup, signingIn);
    const steps = journeyOf({
        setup,
        signedIn: setup.state !== `signedOut`,
        name: setup.name,
        signingIn,
        withSignIn: facts.withSignIn === true || setup.state === `signedOut` || setup.state === `signedIn`,
    });
    return { percent: undefined, step: undefined, left: undefined, ...draft, steps, carriesOn: draft.tone === `working` };
};

/**
 * The rail tile's mark, for a reader who has left the page: work under way spins beside the tile, a step waiting on
 * them asks for attention, a failure says so, and a folder just in is ticked. None before the press.
 */
export const setupBadgeOf = (view: SetupView | undefined, setup: LocalFolderSetup | undefined): ViewBadge | undefined => {
    if (view === undefined || setup === undefined) {
        return undefined;
    }
    const doing = activeStep(view.steps)?.note ?? view.title;
    switch (view.tone) {
        case `working`:
            return { running: view.percent === undefined ? doing : t(`local.setup.badge.percent`, { percent: view.percent }) };
        case `asking`:
        case `waiting`:
            return { mark: `exclamation-circle`, tone: `warning`, tooltip: view.title };
        case `failed`:
            return { mark: `exclamation-circle`, tone: `danger`, tooltip: view.title };
        case `ready`:
            return { mark: `check`, tone: `info`, tooltip: t(`local.setup.badge.ready`) };
    }
};

/** The folder's own button in Files: what it says, and whether a press asks, opens its sandbox, or shows the page. */
export interface FolderButton {
    readonly label: string;
    /** The folder is on its way: the button says how far rather than what it does. */
    readonly busy: boolean;
    readonly press: `ask` | `open` | `view`;
}

// The folder on its way, not in yet: what its button says about how far, or what it waits for. A press shows the page,
// which holds whatever there is to do.
const onItsWayLabel = (setup: LocalFolderSetup, signingIn: boolean): [string, boolean] => {
    switch (setup.state) {
        case `signedOut`:
            return signingIn ? [t(`local.setup.button.signingIn`), true] : [t(`local.setup.button.signIn`), false];
        case `signedIn`:
            return [t(`local.setup.button.signedIn`), true];
        case `queued`:
            return setup.behind === undefined ? [t(`local.setup.button.waiting`), true] : [t(`local.setup.button.behind`), true];
        case `creating`:
            return [t(`local.setup.button.waitingPercent`, { percent: setup.percent }), true];
        case `interrupted`:
            return [t(`local.setup.button.waiting`), true];
        case `copying`:
            return setup.status === `paused` ? [t(`local.setup.button.paused`), false] : [t(`local.setup.button.copying`), true];
        case `failed`:
            return [t(`local.setup.button.failed`), false];
        case `needsDocker`:
            return [t(`local.setup.button.needsDocker`), false];
        case `waiting`:
            return [t(`local.setup.button.needsYou`), false];
        case `ready`:
            return [t(`local.localFiles.openSandbox`), false];
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
        const [label, busy] = onItsWayLabel(setup, facts.signingIn === true);
        return { label, busy, press: `view` };
    }
    if (facts.hasSandbox || setup?.state === `ready`) {
        return { label: t(`local.localFiles.openSandbox`), busy: false, press: `open` };
    }
    return { label: t(`local.localFiles.withAgent`), busy: false, press: `ask` };
};
