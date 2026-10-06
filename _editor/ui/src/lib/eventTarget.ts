// The kit's floating surfaces: an anchored overlay, a dialog, a context menu, a popover. Each is teleported to the body,
// so a press or a key inside one lands outside whatever opened it; a surface deciding whether the reader went elsewhere
// asks this rather than naming the classes itself.
const OVERLAYS = `.ui-anchored, [role="dialog"], .p-contextmenu, .p-popover`;

/** Whether `target` is inside one of the kit's floating surfaces, which answer their own presses and their own Escape. */
export const isOverlayTarget = (target: EventTarget | null): boolean => target instanceof Element && target.closest(OVERLAYS) !== null;

// A field that takes the keyboard as text: the native ones (a select counts, since typing a letter there picks an
// option), a custom `role="textbox"`, and anything editable in place. CodeMirror and the markdown editor are
// contenteditable; xterm and Monaco type into a hidden textarea. `closest`, not the element alone, so a press on
// something drawn inside a field (an <option>, an SVG icon in an editable line) still counts as landing in it.
const FIELDS = `input, textarea, select, [role="textbox"]`;

/** Whether a key or press on `target` belongs to a field the person is typing in, which owns its own keys. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) {
        return false;
    }
    if (target.closest(FIELDS) !== null) {
        return true;
    }
    // `isContentEditable` is the inherited answer, but only an HTML element carries it.
    const html = target instanceof HTMLElement ? target : target.closest<HTMLElement>(`[contenteditable]`);
    return html?.isContentEditable === true;
};
