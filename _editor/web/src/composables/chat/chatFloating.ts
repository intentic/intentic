import { createFloatingSurface, type FloatingSurface } from "../floating";
import { toScreenPx } from "../uiScale";
import { useLayout } from "../useLayout";

/* The chat panel's own window (its button on the chat bar, plus a row in that bar's right-click menu), a
 * module-level singleton like the rest of the layout/chat state. The window is a real window of the app on
 * /floating/chat and it renders the panel itself (composables/floating.ts holds the whole arrangement and why it
 * is one shared fact rather than a bond between two windows).
 *
 * While the chat floats, every other window collapses its chat column: there is one chat surface at a time, and
 * it is wherever the user put it. On a wide surface the panel turns on its side, so the bar's chat list becomes
 * a permanent left rail beside the transcript, where the docked column can only afford to drop it as a sheet.
 * The floor keeps the window usable even when the docked panel is at its narrowest. */

const layout = useLayout();

const surface = createFloatingSurface(`chat`, () => ({
    /* A window is asked for in the screen's own pixels, so the docked width converts on the way out. The floor
     * does not: it is a real window's minimum, not a measurement of the app's type. It sits at Tailwind's `lg`
     * because this window now decides its OWN form: the panel it holds reads the app's breakpoints against this
     * viewport rather than the one it was torn off, and a floating chat opening below `md` would open wearing
     * the mobile shell's shape. Dragging it narrower is still allowed; that is the reader's call. */
    width: Math.max(toScreenPx(layout.chatWidth.value), 1024),
    height: Math.min(window.innerHeight, 900),
}));

export function useChatFloating(): FloatingSurface {
    return surface;
}
