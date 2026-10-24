import { readonly, ref } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { useAccount } from "../../client/auth/useAccount";
import { signInAt } from "../../lib/routes/signIn";

// ONE "ADD SANDBOX" ACTION, over the home or workspace the reader is already in. The dialog is mounted once by the
// shell (features/setup/add/AddSandboxDialog.vue), including for the account's first sandbox. Signing in is the only
// detour: it returns to the home address whose query asks that same dialog to open.
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

/** Adds in place once signed in; otherwise asks for sign-in and returns to this same dialog on home. */
export const requestAddSandbox = (authenticated: boolean, navigate: (destination: RouteLocationRaw) => void): void => {
    if (!authenticated) {
        navigate(signInAt(ADD_SANDBOX_HOME_PATH));
        return;
    }
    askAddSandbox();
};

/** The add action shared by the home rail, sandbox switcher, phone menu and command palette. */
export const useRequestAddSandbox = (): (() => void) => {
    const { user } = useAccount();
    const router = useRouter();
    return () => requestAddSandbox(user.value !== null, (destination) => void router.push(destination));
};
