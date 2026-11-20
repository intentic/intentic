import { deviceKey, removeStoredValue, storedValue, storeValue } from "@intentic/ui/storage";
import { ref } from "vue";
import { signInThroughBrowser } from "../../app/environments/desktop";
import { returnPath } from "../../lib/routes/signIn";

// The desktop app's sign-in happens in the browser, and its own window used to stay exactly as it was for the minutes
// that took: a new user came back to it five times, to the same button. After the press the window says where the
// sign-in went, can open it again (a tab closed by mistake, a browser that never came forward), and has a way back.
// Nothing here ends the wait: the hand-off's return reloads this page, whether its link came or the app found it on the
// platform itself (auth.rs `watch_platform`).
//
// The wait is the window's, not the view's: held once here, so a sign-in page drawn again while the browser has it (a
// route change, the wall over a sandbox coming back) still says where the sign-in went instead of offering the button.
// allow(module-state): the desktop window's one sign-in hand-off, about the account rather than any sandbox
const waiting = ref(false);
// The wait has gone on long enough that the browser's half may never come back (a browser that would not launch the app
// again without a fresh click: auth.rs `watch_platform`), so the dialog points at the emailed code it also offers.
// allow(module-state): the same wait's second beat
const waitingLong = ref(false);
// allow(module-state): the timer that raises it
let longTimer: ReturnType<typeof setTimeout> | undefined;
/** How long a wait for the browser runs before the dialog offers the emailed code as the way on. */
export const WAITING_LONG_MS = 60_000;
const DESTINATION_KEY = deviceKey(`intentic.desktopAuthDestination`);

/** The route the app returns to after its browser handoff; only this webview's tab can read it. */
export const takeBrowserHandoffDestination = (): string => {
    const destination = returnPath(storedValue(DESTINATION_KEY, `session`));
    removeStoredValue(DESTINATION_KEY, `session`);
    return destination;
};

export const useBrowserHandoff = () => {
    const start = (destination = `/`): void => {
        waiting.value = true;
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
            waitingLong.value = waiting.value;
        }, WAITING_LONG_MS);
        storeValue(DESTINATION_KEY, returnPath(destination), `session`);
        signInThroughBrowser();
    };
    // Back to the button; a sign-in finished in the browser anyway is still taken when it arrives.
    const cancel = (): void => {
        waiting.value = false;
        waitingLong.value = false;
        clearTimeout(longTimer);
    };
    return { waiting, waitingLong, start, cancel };
};
