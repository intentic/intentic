import { createFloatingSurface, type FloatingSurface } from "../floating";

/* The global terminal panel's own window (right-click the panel's tab strip, mirroring the chat strip): the
 * WHOLE panel, every tab, in a real, resizable, full-screenable window, so shells and dev servers stay
 * watchable beside other apps. The window runs its own copy of the app and reattaches each tmux session, which
 * redraws on attach exactly as a reload already does (composables/floating.ts holds the arrangement).
 *
 * While the terminal floats, every other window renders nothing in its docked slot, and out there the tab strip
 * stands on the window's left edge. */

const surface = createFloatingSurface(`terminal`, () => ({
    width: Math.min(window.innerWidth, 1100),
    height: Math.min(window.innerHeight, 700),
}));

export function useTerminalFloating(): FloatingSurface {
    return surface;
}
