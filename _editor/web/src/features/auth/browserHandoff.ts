import { deviceKey, removeStoredValue, storedValue, storeValue } from "@intentic/ui/storage";
import { ref } from "vue";
import { signInThroughBrowser } from "../../app/environments/desktop";
import { returnPath } from "../../lib/routes/signIn";

// The desktop app's sign-in happens in the browser, and its own window used to stay exactly as it was for the minutes
// that took: a new user came back to it five times, to the same button. After the press the window says where the
// sign-in went, can open it again (a tab closed by mistake, a browser that never came forward), and has a way back.
// Nothing here ends the wait: the hand-off's return reloads this page.
//
// The wait is the window's, not the view's: held once here, so a sign-in page drawn again while the browser has it (a
// route change, the wall over a sandbox coming back) still says where the sign-in went instead of offering the button.
// allow(module-state): the desktop window's one sign-in hand-off, about the account rather than any sandbox
const waiting = ref(false);
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
        storeValue(DESTINATION_KEY, returnPath(destination), `session`);
        signInThroughBrowser();
    };
    // Back to the button; a sign-in finished in the browser anyway is still taken when it arrives.
    const cancel = (): void => {
        waiting.value = false;
    };
    return { waiting, start, cancel };
};
