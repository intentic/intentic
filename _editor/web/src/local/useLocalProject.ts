import { errorMessage } from "@intentic/base/errors";
import { projectDirCandidates, projectDirNameFor } from "@intentic/sandbox-contract/ids/project-dir";
import { computed, ref, watch } from "vue";
import { askLocalApp } from "../app/environments/local";
import {
    localHost,
    type LocalFolderSandbox,
    type LocalMachineSandbox,
    type LocalProjectHost,
    type LocalProjectPreview,
} from "../app/environments/localHost";
import { machineCardOf } from "./machineCard";
import { useSandboxOpening } from "./folderSandbox";

// "WORK ON THIS WITH AN AGENT", as this window asks it: its own dialog first (LocalProjectDialog.vue), and then the
// folder put in line for this computer's own sandbox, which the app makes after sign-in and keeps (its machine_sandbox.rs).
// The press never waits on it: the dialog goes at once, and the card in the window's corner (LocalMachineCard.vue) and the
// folder's own button say how far the sandbox and the folder are. Every local window carries the card while the sandbox
// is not ready. Where the app cannot answer from here (a page with no app behind it), the press goes to the app by link,
// as it always did.

// allow(module-state): one folder per window, so one question about it.
const dialogOpen = ref(false);
// What the dialog draws; undefined while the app is still weighing the folder.
// allow(module-state): the one dialog this window's folder has.
const preview = ref<LocalProjectPreview | undefined>(undefined);
// allow(module-state): the one press this window's dialog has under way.
const attaching = ref(false);
// Why the last press put nothing in line, in the app's own words.
// allow(module-state): the one dialog this window's folder has.
const failure = ref<string | undefined>(undefined);
// The card folded to one line by the reader, who can unfold it from there or from the folder's button.
// allow(module-state): the one card this window shows.
const minimized = ref(false);
// This computer's sandbox, and then this window's folder, became ready while the window watched: said for a moment.
// allow(module-state): the one card this window shows.
const justReady = ref(false);
// allow(module-state): the one card this window shows.
const folderJustReady = ref(false);
// The reader sent to the browser from this window to sign in for this computer's sandbox: the card says to finish
// there, not to sign in again, until the app hears who signed in, or the sign-in runs out as the app's does (auth.rs
// `ATTEMPT_TTL`) and the card asks again.
// allow(module-state): the one sign-in this window's card asks for.
const signingIn = ref(false);
const SIGNING_IN_FOR_MS = 3 * 60_000;
let signingInUntil: ReturnType<typeof setTimeout> | undefined;
// This window's own dialog put its folder in line: once the folder is in, the window takes the reader into its sandbox,
// which is what they asked for, rather than leaving them to find the way there (2026-10-17).
// allow(module-state): one folder per window, so one ask about it.
const askedHere = ref(false);

const host = () => localHost().project;

const machine = computed<LocalMachineSandbox | undefined>(() => host()?.machine.value);
const folder = computed<LocalFolderSandbox | undefined>(() => host()?.folder.value);

/** The card this window carries, while it carries one. */
const card = computed(() =>
    machineCardOf({
        machine: machine.value,
        folder: folder.value,
        justReady: justReady.value,
        folderJustReady: folderJustReady.value,
        signingIn: signingIn.value,
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
const FOLDED_KEY = `intentic.local.machineCardFolded`;
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
        () => machine.value?.state,
        (now, before) => {
            if (now === `ready` && before !== undefined && before !== `ready`) {
                flash(justReady);
            }
        },
    );
    watch(
        () => machine.value?.state,
        (now) => {
            if (now !== `signedOut`) {
                stopSigningIn();
            }
        },
    );
    watch(
        () => folder.value?.state,
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
            flash(folderJustReady, asked);
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
    // A folder on its way in, or turned down, is answered by its card: brought back rather than a second question asked.
    if (folder.value !== undefined && folder.value.state !== `ready`) {
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
 * The dialog's button: the folder put in line under its name in /work (sandbox-contract's `projectDirNameFor`, made
 * unique by the app), and the dialog gone at once. Nobody signed in is asked to sign in now, and the sandbox, and the
 * folder in it, follow the sign-in by themselves.
 */
// Answers `pcSetup` when the folder is in but this PC cannot run agents yet: the dialog then takes the reader to This
// computer, whose card sets the PC up (the dialog navigates, since this module sits below the router).
const attach = async (): Promise<`pcSetup` | undefined> => {
    const project = host();
    const asked = preview.value;
    if (project === undefined || asked?.kind !== `new` || attaching.value) {
        return undefined;
    }
    attaching.value = true;
    failure.value = undefined;
    try {
        // Its own name, or, taken already, its parent's in front of it (`code-app`) rather than a number.
        const named = projectDirNameFor(asked.name);
        const started = await project.attach({ project: named, alternatives: projectDirCandidates(asked.path).filter((name) => name !== named) });
        askedHere.value = started === `queued`;
        fold(false);
        dialogOpen.value = false;
        const pc = localHost().onboarding?.check.value;
        const askedMachine = asked.machine;
        if (pc !== undefined && pc.state !== `ready` && askedMachine.state !== `ready` && askedMachine.state !== `signedOut`) {
            return `pcSetup`;
        }
        if (asked.machine.state === `signedOut`) {
            await signInFor(project);
        }
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        attaching.value = false;
    }
    return undefined;
};

const cancel = (): void => {
    if (!attaching.value) {
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

/** This window's folder put in line again, after the agent turned it down. */
const retryFolder = (): Promise<void> =>
    pressed(async () => {
        const project = host();
        const turnedDown = folder.value;
        if (project !== undefined && turnedDown !== undefined) {
            await project.attach({ project: turnedDown.name });
        }
    });

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
    signingInUntil = setTimeout(stopSigningIn, SIGNING_IN_FOR_MS);
    try {
        await project.act(`signIn`);
    } catch (error) {
        stopSigningIn();
        throw error;
    }
}

/** Sign in for this computer's sandbox, from the card or the folder's button. */
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
    folderJustReady.value = false;
};

export const useLocalProject = () => {
    watchCard();
    return {
        dialogOpen,
        preview,
        attaching,
        failure,
        minimized,
        attention,
        machine,
        folder,
        card,
        ask,
        attach,
        cancel,
        fold,
        retryFolder,
        open,
        signIn,
        signingIn,
        dismiss,
        pressed,
        actionFailure,
    };
};
