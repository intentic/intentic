import { errorMessage } from "@intentic/base/errors";
import { projectDirNameFor } from "@intentic/sandbox-contract/ids/project-dir";
import { computed, ref, watch } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { localHost, type LocalFolderSetup, type LocalProjectHost, type LocalProjectPreview } from "../app/environments/localHost";
import { useAccount } from "../client/auth/useAccount";
import { useSandboxOpening } from "./folderSandbox";
import { SANDBOX_SETUP_PATH } from "./setup/setupPath";
import { setupBadgeOf, setupViewOf } from "./setup/setupView";

// "WORK ON THIS WITH AN AGENT", as this window asks it and follows it: one page (setup/LocalSandboxSetup.vue) that says
// what a sandbox of the folder's own involves, asks once, and then follows the whole way there: the sign-in where
// nobody is signed in, the sandbox the app makes on the press (its folder_setup.rs), the folder's copy, and the open
// sandbox. The reader can leave the page for Files meanwhile; the rail's tile for it says how far it is
// (LocalShell.vue). Where the app cannot answer from here (a page with no app behind it), the press goes to the app by
// link, as it always did.

// What the page says about the folder before the press; undefined while the app is still weighing it.
// allow(module-state): one folder per window, so one question about it.
const preview = ref<LocalProjectPreview | undefined>(undefined);
// allow(module-state): the one press this window's page has under way.
const creating = ref(false);
// Why the last press made nothing, or why the app could not weigh the folder, in the app's own words.
// allow(module-state): the one page this window's folder has.
const failure = ref<string | undefined>(undefined);
// This window's folder went into its sandbox while the window watched: its tile stays on the rail, ticked, until the
// reader opens the sandbox or looks at the page.
// allow(module-state): the one folder this window follows.
const justReady = ref(false);
// The reader sent to the browser from this window to sign in for the folder's sandbox: the page says to finish there,
// not to sign in again, until the app hears who signed in, or the sign-in runs out as the app's does (auth.rs
// `ATTEMPT_TTL`) and the page asks again.
// allow(module-state): the one sign-in this window's page asks for.
const signingIn = ref(false);
const SIGNING_IN_FOR_MS = 3 * 60_000;
let signingInUntil: ReturnType<typeof setTimeout> | undefined;
// The reader signed in from this window on the folder's way: the sign-in stays a step of it, ticked, until the folder is
// no longer on its way (journey.ts).
// allow(module-state): the one folder this window follows.
const signedInHere = ref(false);
// This window's own page asked for its folder's sandbox: once the folder is in, the window takes the reader into it,
// which is what they asked for, rather than leaving them to find the way there (2026-10-17).
// allow(module-state): one folder per window, so one ask about it.
const askedHere = ref(false);

const host = () => localHost().project;

const setup = computed<LocalFolderSetup | undefined>(() => host()?.setup.value);

/** What the page says now (setupView.ts). */
const view = computed(() =>
    setupViewOf({
        setup: setup.value,
        preview: preview.value,
        name: localFace()?.name ?? ``,
        path: localFace()?.path ?? ``,
        signingIn: signingIn.value,
        withSignIn: signedInHere.value,
    }),
);

/** Whether the page has a tile on the rail: while the folder is on its way, and once it is in until the reader has seen it. */
const inRail = computed(() => setup.value !== undefined && (setup.value.state !== `ready` || justReady.value));

/** The tile's mark while the page is out of sight. */
const badge = computed(() => (inRail.value ? setupBadgeOf(view.value, setup.value) : undefined));

// Who is signed in, asked of the platform again; one out of reach is asked once more on the window's next focus.
const recheckAccount = async (): Promise<void> => {
    try {
        await useAccount().refresh();
    } catch (error) {
        console.warn(`[local] who signed in could not be asked yet:`, error);
    }
};

// The reader is looking at this window: the one a move into the sandbox can be made in without taking them from
// something else.
const readerHere = (): boolean => document.visibilityState === `visible` && document.hasFocus();

let watching = false;
// Watched once per window, from the first reader of this module on.
const watchSetup = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    watch(
        () => setup.value?.state,
        (now, before) => {
            if (now !== `signedOut`) {
                stopSigningIn();
            }
            // Past the sign-in: the window asks who signed in now rather than at its next focus, so its rail's foot and
            // the page name the account the folder's sandbox is being made for.
            if (before === `signedOut` && now !== undefined && now !== `signedOut`) {
                void recheckAccount();
            }
        },
    );
    watch(
        () => setup.value === undefined,
        (gone) => {
            if (gone) {
                signedInHere.value = false;
                justReady.value = false;
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
            justReady.value = true;
            if (asked && readerHere()) {
                void open();
            }
        },
    );
};

/**
 * What the app says about the folder, asked afresh: the page's own first look, before anything was pressed. A folder
 * with a record (on its way, stopped, or just in) has that to say it instead; one that has its sandbox already is opened.
 */
const weigh = async (): Promise<`opened` | undefined> => {
    const project = host();
    if (project === undefined || setup.value !== undefined) {
        return undefined;
    }
    failure.value = undefined;
    preview.value = undefined;
    try {
        const answer = await project.preview();
        if (answer.kind === `existing`) {
            askLocalApp(`sandbox`);
            return `opened`;
        }
        preview.value = answer;
    } catch (error) {
        failure.value = errorMessage(error);
    }
    return undefined;
};

/**
 * "Work on this with an agent": the page, in this window; `go` takes the reader there (this module sits below the
 * router). A page with no app behind it asks the app by link instead.
 */
const ask = (go: (path: string) => void): void => {
    if (host() === undefined) {
        askLocalApp(`sandbox`);
        return;
    }
    go(SANDBOX_SETUP_PATH);
};

/**
 * The page's press: a sandbox of the folder's own, with the folder under its name in /work (sandbox-contract's
 * `projectDirNameFor`). Nobody signed in is sent to sign in now, and the sandbox, and the folder's copy in it, follow
 * the sign-in by themselves, on the same page.
 */
const create = async (): Promise<void> => {
    const project = host();
    const asked = preview.value;
    if (project === undefined || asked?.kind !== `new` || creating.value) {
        return;
    }
    creating.value = true;
    failure.value = undefined;
    try {
        const started = await project.create(projectDirNameFor(asked.name));
        askedHere.value = started === `started`;
        if (!asked.signedIn) {
            await signInFor(project);
        }
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        creating.value = false;
    }
};

// Why the page's last press did nothing, said on the page.
// allow(module-state): the one page this window shows.
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
        justReady.value = false;
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

// The app's sign-in, in the browser, said on the page from the press on.
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

/** Sign in for the folder's sandbox, from the page. */
const signIn = (): Promise<void> =>
    pressed(async () => {
        const project = host();
        if (project !== undefined) {
            await signInFor(project);
        }
    });

/** The reader has seen the folder in: its tile can leave the rail. */
const seen = (): void => {
    if (setup.value?.state === `ready`) {
        justReady.value = false;
    }
};

export const useLocalProject = () => {
    watchSetup();
    return {
        preview,
        creating,
        failure,
        setup,
        view,
        inRail,
        badge,
        weigh,
        ask,
        create,
        open,
        signIn,
        signingIn,
        seen,
        pressed,
        actionFailure,
    };
};
