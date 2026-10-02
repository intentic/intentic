import { computed, type ComputedRef, ref } from "vue";
import { DESKTOP_SHOWN_EVENT, type DesktopShownEvent } from "../../app/environments/desktop";

// Whether this window's document is visible (document.visibilityState), gating the chat's "Updated" badge and idle
// reporting to the sandbox; each window answers for itself. An occluded but not minimized window still counts as
// visible, since the browser only reports hidden for a minimized window or a background tab.
//
// Inside the desktop app the app says it too (desktop-app shown.rs): on Windows the webview reports "visible" for a
// window hidden in the tray or minimised, which left the sandbox believing the reader was watching all day and holding
// back every push to their phone. A window the app says nothing about is shown, as it was before the app said anything.

// allow(module-state): this window's own visibility
const visible = ref(true);
// allow(module-state): whether the desktop app says this window is on screen; it only ever narrows the document's word
const shown = ref(true);

export const onScreen: ComputedRef<boolean> = computed(() => visible.value && shown.value);

/** The app's word on whether this window is shown; exported for tests, which have no app to say it. */
export const receiveDesktopShown = (said: boolean): void => {
    shown.value = said;
};

if (typeof document !== `undefined`) {
    const sync = (): void => {
        visible.value = document.visibilityState === `visible`;
    };
    document.addEventListener(`visibilitychange`, sync);
    sync();
    window.addEventListener(DESKTOP_SHOWN_EVENT, (event) => {
        // SAFETY: only the app dispatches this event, with `{ shown }` (shown.rs); a detail without a boolean there
        // matches neither branch below and says nothing.
        const said = (event as CustomEvent<Partial<DesktopShownEvent> | null>).detail?.shown;
        if (said === true || said === false) {
            receiveDesktopShown(said);
        }
    });
}
