import type { SandboxSummary } from "@intentic/api-contract";
import { computed, readonly, ref, shallowRef } from "vue";

// ONE "REMOVE SANDBOX" QUESTION FOR THE WINDOW, asked from wherever its press is: the sandbox's own settings (its
// Overview) and the gate screens that stand in for a sandbox whose settings cannot open. The dialog that answers it is
// mounted once by the shell (features/sandbox/gates/removal/RemoveSandboxHost.vue), above every page, so removing the
// sandbox on screen, which switches to another and takes the page that asked with it, never takes the dialog too.
//
// The ask lives here, below the features, for the same reason as addSandbox.ts: the overview and the gates raise a
// dialog without importing its host.

// allow(module-state): one Remove sandbox dialog for the window, asked for from wherever its press is
const asked = shallowRef<SandboxSummary | undefined>(undefined);
// allow(module-state): whether the host has been needed yet, so its chunk is fetched on the first ask and kept after
const needed = ref(false);

/** The sandbox the dialog is about; undefined while it is shut. */
export const removeSandboxAsked = computed(() => asked.value);

/** Whether the dialog's host has been asked for at least once in this window, and so stays mounted. */
export const removeSandboxNeeded = readonly(needed);

/** Opens the dialog on this sandbox: removing it for its owner, leaving it for anyone else. */
export const askRemoveSandbox = (row: SandboxSummary): void => {
    needed.value = true;
    asked.value = row;
};

/** Shuts it; a removal it started carries on in the operations ledger (RemoveSandboxDialog.vue). */
export const closeRemoveSandbox = (): void => {
    asked.value = undefined;
};
