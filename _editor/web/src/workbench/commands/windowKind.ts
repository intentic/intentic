import { desktopApp } from "../../app/environments/desktop";

// Which keys this window may claim. A browser tab may not take the browser's own (Chromium refuses a page ⌘W/Ctrl+W,
// new tab, new window, reopen tab and every tab-switching chord: `kReservedCommandIds` in its accelerator_table.cc),
// while an installed app window gets all of them ("In Apps mode, no keys are reserved", browser_command_controller.cc),
// and so does the desktop app's own webview. Safari's Dock apps are left out: what they hand a page is unmeasured, and a
// chord the window takes back would close it rather than a tab.

const APP_DISPLAY = `(display-mode: standalone), (display-mode: window-controls-overlay)`;

/** Whether this window keeps no keys from the page: the desktop app, or an installed Chromium app window. */
export const inAppWindow = (): boolean => {
    if (desktopApp() !== undefined) {
        return true;
    }
    // `userAgentData` is Chromium's alone, which is the engine whose app windows are measured to reserve nothing.
    return `userAgentData` in navigator && globalThis.matchMedia?.(APP_DISPLAY).matches === true;
};
