import { createPopout, type Popout } from "../usePopout";
import { toScreenPx } from "../uiScale";
import { useLayout } from "../useLayout";

/* The chat panel's pop-out window (its own button on the chat bar, plus a row in that bar's right-click menu)
 * — a module-level singleton like the rest of the layout/chat state. While popped out the shell collapses the
 * chat grid column, and the bar's chat list moves to the window's right edge as a permanent rail: a real window
 * has the width to keep the list open beside the transcript, where the docked column can only afford to drop
 * it as a sheet. The floor keeps the window usable even when the docked panel is at its narrowest. */

const layout = useLayout();

const popout = createPopout(`chat`, `Intentic · Chat`, () => ({
    // A window is asked for in the screen's own pixels, so the docked width converts on the way out. The floor
    // does not: it is a real window's minimum, not a measurement of the app's type.
    width: Math.max(toScreenPx(layout.chatWidth.value), 720),
    height: Math.min(window.innerHeight, 900),
}));

export function useChatPopout(): Popout {
    return popout;
}
