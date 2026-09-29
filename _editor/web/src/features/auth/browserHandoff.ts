import { ref } from "vue";
import { signInThroughBrowser } from "../../app/environments/desktop";

// The desktop app's sign-in happens in the browser, and its own window used to stay exactly as it was for the minutes
// that took: a new user came back to it five times, to the same button. After the press the window says where the
// sign-in went, can open it again (a tab closed by mistake, a browser that never came forward), and has a way back.
// Nothing here ends the wait: the hand-off's return reloads this page.
export const useBrowserHandoff = () => {
    const waiting = ref(false);
    const start = (): void => {
        waiting.value = true;
        signInThroughBrowser();
    };
    // Back to the button; a sign-in finished in the browser anyway is still taken when it arrives.
    const cancel = (): void => {
        waiting.value = false;
    };
    return { waiting, start, cancel };
};
