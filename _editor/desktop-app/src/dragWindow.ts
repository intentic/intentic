import { getCurrentWindow } from "@tauri-apps/api/window";

/* THE CARD IS MOVED BY ITS HEADER, ALL OF IT — this window has no title bar to drag it by (windows.rs), and a
   header that only drags where no glyph landed is a window that feels stuck. */

/* Anything a press could have been meant for instead. */
const CONTROLS = `a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable="true"]`;

/** True when a press belongs to the bar itself rather than to a control standing in it. */
export const dragsWindow = (target: EventTarget | null, button: number): boolean =>
    button === 0 && target instanceof Element && target.closest(CONTROLS) === null;

/** Hands a press on a header to the platform's own move loop; never maximises, the card's size being its content's. */
export const dragWindow = (event: MouseEvent): void => {
    if (!dragsWindow(event.target, event.button)) {
        return;
    }
    /* A press that moves the window must not also plant a text caret in what it landed on. */
    event.preventDefault();
    void getCurrentWindow().startDragging();
};
