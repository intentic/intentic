import { useDevice } from "@intentic/ui";
import { readonly, ref } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { useAccount } from "../../client/auth/useAccount";
import { useRole } from "../../client/sandbox/useRole";
import { signInAt } from "../../lib/routes/signIn";

// ONE "ADD SANDBOX" ACTION, wherever it is pressed. On a desktop it is made on Home, from a dialog over it and then in a
// tile of its own rail (features/home/newSandbox/newSandbox.ts), whatever the press was in; Home's address with the ask
// in it is what puts the dialog up. Where there is no Home to make it on (a phone, which has no rail, and a guest's window, whose way in
// is a box's chat) it is the dialog the shell mounts (features/setup/add/AddSandboxDialog.vue). Signing in is the only
// detour: it returns to the home address whose query asks for either.
//
// The ask lives here, below the features, so the switcher, the home rail and the phone's menu can raise a dialog that
// is setup's without importing it (layers.json: no two features may form a cycle, and setup already reads sandbox's).

/**
 * The workspace's address that opens the dialog by itself: how the desktop app's folder window, which cannot read the
 * owner's connected machines, hands the add to the workspace window (switcherPlace.ts), whose shell opens it.
 */
export const ADD_SANDBOX_QUERY = `add`;
export const ADD_SANDBOX_VALUE = `sandbox`;
export const ADD_SANDBOX_PATH = `/?${ADD_SANDBOX_QUERY}=${ADD_SANDBOX_VALUE}`;
export const ADD_SANDBOX_HOME_PATH = `/home?${ADD_SANDBOX_QUERY}=${ADD_SANDBOX_VALUE}`;

// allow(module-state): one Add sandbox dialog for the window, asked for from wherever its press is
const asked = ref(false);

/** Whether the dialog is up. */
export const addSandboxAsked = readonly(asked);

/** Opens the dialog. */
export const askAddSandbox = (): void => {
    asked.value = true;
};

/** Closes it; a setup it started carries on (useAddSandbox.ts). */
export const closeAddSandbox = (): void => {
    asked.value = false;
};

// WARMED BEFORE THE PRESS (2026-10-26). The dialog's run is a chunk of its own, fetched the first time it is asked for;
// on a dev server that is hundreds of module requests, and the owner pressed Add sandbox in a sandbox, landed on Home and
// saw no dialog for seconds. The shell, which owns the chunk, registers its fetch here; it runs once the shell is idle
// and again whenever a pointer rests on a way to the press (the switcher, Home's +), so the press finds it loaded.
// allow(module-state): the shell's fetch of the add's chunk, one per window
let warmer: (() => Promise<void>) | undefined;

/** The shell names how the add's chunk is fetched; a second call replaces the first. */
export const setAddSandboxWarmer = (load: () => Promise<void>): void => {
    warmer = load;
};

/** Fetches the add's chunk ahead of the press; a failure is the press's to surface, not this. */
export const warmAddSandbox = (): void => {
    // allow(silent-catch): a warm that failed changes nothing; the press fetches again and recovers its own failure
    void warmer?.().catch(() => undefined);
};

/** Whether a window adds on Home rather than through the dialog: a desktop shell, for anyone who has a Home. */
export const addsOnHome = (input: { readonly mobile: boolean; readonly isGuest: boolean; readonly homeOnly: boolean }): boolean =>
    !input.mobile && (!input.isGuest || input.homeOnly);

/** Adds on Home or in the dialog once signed in; otherwise asks for sign-in and returns to the same ask on home. */
export const requestAddSandbox = (authenticated: boolean, onHome: boolean, navigate: (destination: RouteLocationRaw) => void): void => {
    if (!authenticated || onHome) {
        navigate(authenticated ? ADD_SANDBOX_HOME_PATH : signInAt(ADD_SANDBOX_HOME_PATH));
        return;
    }
    askAddSandbox();
};

/** Whether this window adds on Home (above), as its shell and its role stand now. */
export const useAddsOnHome = (): (() => boolean) => {
    const { mobile } = useDevice();
    const { isGuest, homeOnly } = useRole();
    return () => addsOnHome({ mobile: mobile.value, isGuest: isGuest.value, homeOnly: homeOnly.value });
};

/** The add action shared by the home rail, sandbox switcher, phone menu and command palette. */
export const useRequestAddSandbox = (): (() => void) => {
    const { user } = useAccount();
    const router = useRouter();
    const onHome = useAddsOnHome();
    return () => requestAddSandbox(user.value !== null, onHome(), (destination) => void router.push(destination));
};
