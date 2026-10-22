import { desktopVersion, openDesktopLink } from "./desktop";

// THE WORKSPACE SAYING IT SHOWS A SANDBOX, connected and drawn (2026-10-22). The app puts this page up out of sight for a
// folder's new sandbox before it calls the folder ready (its windows.rs `warm_workspace`), so the folder's Open is the
// page on screen rather than its loading; this is what it waits for (SandboxGate.vue says it). Said once per sandbox the
// page comes to show; an app older than the verb drops the link.

// allow(module-state): one page, one sandbox it last said it shows.
let shownSandbox: string | undefined;

export const announceWorkspaceShown = (sandboxId: string): void => {
    if (desktopVersion() === undefined || shownSandbox === sandboxId) {
        return;
    }
    shownSandbox = sandboxId;
    openDesktopLink(`intentic://window?do=shown&sandbox=${encodeURIComponent(sandboxId)}`);
};
