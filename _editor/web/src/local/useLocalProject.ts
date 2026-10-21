import { errorMessage } from "@intentic/base/errors";
import { projectDirNameFor } from "@intentic/sandbox-contract/ids/project-dir";
import { computed, ref, watch } from "vue";
import { askLocalApp } from "../app/environments/local";
import { localHost, type LocalFolderSetup, type LocalProjectHost, type LocalProjectPreview } from "../app/environments/localHost";
import { setupCardOf } from "./setupCard";
import { useSandboxOpening } from "./folderSandbox";

// "WORK ON THIS WITH AN AGENT", as this window asks it: its own dialog first (LocalProjectDialog.vue), and then a sandbox
// of the folder's own, which the app makes on the press (its folder_setup.rs). The press never waits on it: the dialog
// goes at once, and the card in the window's corner (LocalSetupCard.vue) and the folder's own button say how far the
// sandbox and the folder's copy are. Where the app cannot answer from here (a page with no app behind it), the press goes
// to the app by link, as it always did.

// allow(module-state): one folder per window, so one question about it.
const dialogOpen = ref(false);
// What the dialog draws; undefined while the app is still weighing the folder.
// allow(module-state): the one dialog this window's folder has.
const preview = ref<LocalProjectPreview | undefined>(undefined);
// allow(module-state): the one press this window's dialog has under way.
const creating = ref(false);
// Why the last press made nothing, in the app's own words.
// allow(module-state): the one dialog this window's folder has.
const failure = ref<string | undefined>(undefined);
// The card folded to one line by the reader, who can unfold it from there or from the folder's button.
// allow(module-state): the one card this window shows.
const minimized = ref(false);
// This window's folder went into its sandbox while the window watched: said for a moment.
// allow(module-state): the one card this window shows.
const justReady = ref(false);
// The reader sent to the browser from this window to sign in for the folder's sandbox: the card says to finish there,
// not to sign in again, until the app hears who signed in, or the sign-in runs out as the app's does (auth.rs
// `ATTEMPT_TTL`) and the card asks again.
// allow(module-state): the one sign-in this window's card asks for.
const signingIn = ref(false);
const SIGNING_IN_FOR_MS = 3 * 60_000;
let signingInUntil: ReturnType<typeof setTimeout> | undefined;
// The reader signed in from this window on the folder's way: the sign-in stays a step of it, ticked, on the card
// (journey.ts), until the folder is no longer on its way.
// allow(module-state): the one folder this window's card follows.
const signedInHere = ref(false);
// This window's own dialog asked for its folder's sandbox: once the folder is in, the window takes the reader into it,
// which is what they asked for, rather than leaving them to find the way there (2026-10-17).
// allow(module-state): one folder per window, so one ask about it.
const askedHere = ref(false);

const host = () => localHost().project;

const setup = computed<LocalFolderSetup | undefined>(() => host()?.setup.value);

/** The card this window carries, while it carries one. */
const card = computed(() =>
    setupCardOf({
        setup: setup.value,
        justReady: justReady.value,
        signingIn: signingIn.value,
        withSignIn: signedInHere.value,
    }),
);

// How long "ready" stays on the card: long enough to be seen by a reader who looks up, not long enough to be in the way.
// A folder this window asked for, ready while the reader was away, keeps its card until they press it or put it away.
const READY_FOR_MS = 12_000;
const flash = (shown: typeof justReady, held = false): void => {
    shown.value = true;
    if (!held) {
        setTimeout(() => (shown.value = false), READY_FOR_MS);
    }
};

// The reader is looking at this window: the one a move into the sandbox can be made in without taking them from
// something else.
const readerHere = (): boolean => document.visibilityState === `visible` && document.hasFocus();

// A fold is remembered for what the card showed when it was folded, in every window of the app (they share the
// storage): the same news is not unfolded again in the next window opened, and new news is.
const FOLDED_KEY = `intentic.local.setupCardFolded`;
const foldedKey = (): string | null => {
    try {
        return localStorage.getItem(FOLDED_KEY);
    } catch {
        // allow(silent-catch): storage refused (a private window) is a fold nobody remembered, which unfolds the card.
        return null;
    }
};
const rememberFold = (key: string | undefined): void => {
    try {
        if (key === undefined) {
            localStorage.removeItem(FOLDED_KEY);
        } else {
            localStorage.setItem(FOLDED_KEY, key);
        }
    } catch {
        // allow(silent-catch): storage refused (a private window): the fold holds for this window alone.
    }
};

let watching = false;
// Watched once per window, from the first reader of this module on.
const watchCard = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    watch(
        () => setup.value?.state,
        (now) => {
            if (now !== `signedOut`) {
                stopSigningIn();
            }
        },
    );
    watch(
        () => setup.value === undefined,
        (gone) => {
            if (gone) {
                signedInHere.value = false;
            }
        },
    );
    watch(
        () => setup.value?.state,
        (now, before) => {
            if (now !== `ready` || before === undefined || before === `ready`) {
                return;
            }
            const asked = askedHere.value;
            askedHere.value = false;
            if (asked && readerHere()) {
                void open();
                return;
            }
            flash(justReady, asked);
        },
    );
    watch(
        () => card.value?.key,
        (key) => {
            minimized.value = key !== undefined && foldedKey() === key;
        },
        { immediate: true },
    );
};

/** The dialog, for this window's folder; a folder that has its sandbox already is opened instead. */
const ask = async (): Promise<void> => {
    const project = host();
    if (project === undefined) {
        askLocalApp(`sandbox`);
        return;
    }
    // A folder on its way to its sandbox, or stopped on the way, is answered by its card: brought back rather than a
    // second question asked.
    if (setup.value !== undefined && setup.value.state !== `ready`) {
        fold(false);
        return;
    }
    failure.value = undefined;
    preview.value = undefined;
    dialogOpen.value = true;
    try {
        const answer = await project.preview();
        if (answer.kind === `existing`) {
            dialogOpen.value = false;
            askLocalApp(`sandbox`);
            return;
        }
        preview.value = answer;
    } catch (error) {
        failure.value = errorMessage(error);
    }
};

/**
 * The dialog's button: a sandbox of the folder's own, with the folder under its name in /work (sandbox-contract's
 * `projectDirNameFor`), and the dialog gone at once. Nobody signed in is asked to sign in now, and the sandbox, and the
 * folder's copy in it, follow the sign-in by themselves.
 */
// Answers `pcSetup` when this PC cannot run agents yet: the dialog then takes the reader to This computer, whose card sets
// the PC up (the dialog navigates, since this module sits below the router).
const create = async (): Promise<`pcSetup` | undefined> => {
    const project = host();
    const asked = preview.value;
    if (project === undefined || asked?.kind !== `new` || creating.value) {
        return undefined;
    }
    creating.value = true;
    failure.value = undefined;
    try {
        const started = await project.create(projectDirNameFor(asked.name));
        askedHere.value = started === `started`;
        fold(false);
        dialogOpen.value = false;
        const pc = localHost().onboarding?.check.value;
        if (pc !== undefined && pc.state !== `ready` && asked.signedIn) {
            return `pcSetup`;
        }
        if (!asked.signedIn) {
            await signInFor(project);
        }
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        creating.value = false;
    }
    return undefined;
};

const cancel = (): void => {
    if (!creating.value) {
        dialogOpen.value = false;
    }
};

// A card asked for while it is already open flashes instead, so the press is never silent. Without it, the folder's
// button in the states that only point at the card (a copy under way, a folder turned down) set `minimized` from false
// to false and nothing on screen moved at all.
// allow(module-state): the one card this window shows.
const attention = ref(false);
const ATTENTION_FOR_MS = 1200;
let attentionUntil: ReturnType<typeof setTimeout> | undefined;

/** The card, folded or unfolded; the fold is remembered for what it showed. One already open is drawn the eye to. */
const fold = (folded: boolean): void => {
    if (!folded && !minimized.value && card.value !== undefined) {
        clearTimeout(attentionUntil);
        attention.value = true;
        attentionUntil = setTimeout(() => (attention.value = false), ATTENTION_FOR_MS);
    }
    minimized.value = folded;
    rememberFold(folded ? card.value?.key : undefined);
};

// Why the card's last press did nothing, said on the card.
// allow(module-state): the one card this window shows.
const actionFailure = ref<string | undefined>(undefined);

const pressed = async (action: () => Promise<unknown>): Promise<void> => {
    actionFailure.value = undefined;
    try {
        await action();
    } catch (error) {
        actionFailure.value = errorMessage(error);
    }
};

/** The folder's sandbox, opened on the folder; the folder's own button says it is opening until it is up. */
const open = (): Promise<void> =>
    pressed(async () => {
        const opening = useSandboxOpening();
        opening.begin();
        try {
            await host()?.open();
        } finally {
            opening.settle();
        }
    });

function stopSigningIn(): void {
    clearTimeout(signingInUntil);
    signingIn.value = false;
}

// The app's sign-in, in the browser, said on the card from the press on.
async function signInFor(project: LocalProjectHost): Promise<void> {
    clearTimeout(signingInUntil);
    signingIn.value = true;
    signedInHere.value = true;
    signingInUntil = setTimeout(stopSigningIn, SIGNING_IN_FOR_MS);
    try {
        await project.act(`signIn`);
    } catch (error) {
        stopSigningIn();
        throw error;
    }
}

/** Sign in for the folder's sandbox, from the card or the folder's button. */
const signIn = (): Promise<void> =>
    pressed(async () => {
        const project = host();
        if (project !== undefined) {
            await signInFor(project);
        }
    });

/** Puts a "ready" card away before its moment is over. */
const dismiss = (): void => {
    justReady.value = false;
};

export const useLocalProject = () => {
    watchCard();
    return {
        dialogOpen,
        preview,
        creating,
        failure,
        minimized,
        attention,
        setup,
        card,
        ask,
        create,
        cancel,
        fold,
        open,
        signIn,
        signingIn,
        dismiss,
        pressed,
        actionFailure,
    };
};
