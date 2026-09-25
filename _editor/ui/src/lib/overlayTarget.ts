// The kit's floating surfaces: an anchored overlay, a dialog, a context menu, a popover. Each is teleported to the body,
// so a press or a key inside one lands outside whatever opened it; a surface deciding whether the reader went elsewhere
// asks this rather than naming the classes itself.
const OVERLAYS = `.ui-anchored, [role="dialog"], .p-contextmenu, .p-popover`;

/** Whether `target` is inside one of the kit's floating surfaces, which answer their own presses and their own Escape. */
export const isOverlayTarget = (target: EventTarget | null): boolean => target instanceof Element && target.closest(OVERLAYS) !== null;
