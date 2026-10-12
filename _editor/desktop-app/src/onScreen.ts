import { computed, type ComputedRef, ref } from "vue";

// WHETHER THIS WINDOW IS WHERE THE READER CAN SEE IT, for what This computer does on a clock. The document's own word is
// not enough inside the app: WebView2 keeps `visible` for a window hidden in the tray or minimised (the app's shown.rs
// says why), so This computer left on screen when the window went to the tray read the machine every 30 seconds for as
// long as the app ran. The app tells each page itself (`intentic-desktop-shown`, `{ shown }`), on every change and once
// when the page's bar comes up. The editor keeps the same reading (the web's workbench/window/onScreen.ts), which this
// package cannot reach past its two seams (tsconfig.json `paths`), so it is read here again from the same two sources. A
// window the app has said nothing about is shown, as the editor's reading has it too.

/** The DOM event the app dispatches on the window (shown.rs `SHOWN_EVENT`). */
export const DESKTOP_SHOWN_EVENT = `intentic-desktop-shown`;

const visible = ref(true);
const shown = ref(true);

/** Whether the reader can see this window: the document visible, and the app not saying it is hidden or minimised. */
export const onScreen: ComputedRef<boolean> = computed(() => visible.value && shown.value);

const heard = (event: Event): void => {
    // SAFETY: only the app dispatches this event, with `{ shown }` (shown.rs); a detail without a boolean there matches
    // neither branch below and says nothing.
    const said = (event as CustomEvent<{ readonly shown?: unknown } | null>).detail?.shown;
    if (said === true || said === false) {
        shown.value = said;
    }
};

const readDocument = (): void => {
    visible.value = document.visibilityState === `visible`;
};

let following = false;

/** Starts hearing both, once per window: called as the host is installed (host.ts), before the app first says. */
export const followOnScreen = (): void => {
    if (following) {
        return;
    }
    following = true;
    readDocument();
    document.addEventListener(`visibilitychange`, readDocument);
    window.addEventListener(DESKTOP_SHOWN_EVENT, heard);
};
