import type { SandboxSummary } from "@intentic/api-contract";
import { readonly, ref } from "vue";
import { switchableSandboxes } from "./live/roster";

// WHICH "ADD SANDBOX" A PRESS GETS, and the ask that opens the dialog. An account already working in a sandbox adds the
// next one in a dialog over where it is (features/setup/add/AddSandboxDialog.vue, mounted once by the shell); one with
// none goes to /setup, whose first-run page decides where a first sandbox runs and explains the rest. A row never
// finished is no working sandbox: /setup resumes it, which is what that reader needs.
//
// The ask lives here, below the features, so the switcher, the home rail and the phone's menu can raise a dialog that
// is setup's without importing it (layers.json: no two features may form a cycle, and setup already reads sandbox's).

/** Whether "Add sandbox" opens the dialog rather than /setup. */
export const addsInDialog = (rows: readonly SandboxSummary[]): boolean => switchableSandboxes(rows).length > 0;

/**
 * The workspace's address that opens the dialog by itself: how the desktop app's folder window, which cannot read the
 * owner's connected machines, hands the add to the workspace window (switcherPlace.ts), whose shell opens it.
 */
export const ADD_SANDBOX_QUERY = `add`;
export const ADD_SANDBOX_VALUE = `sandbox`;
export const ADD_SANDBOX_PATH = `/?${ADD_SANDBOX_QUERY}=${ADD_SANDBOX_VALUE}`;

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
