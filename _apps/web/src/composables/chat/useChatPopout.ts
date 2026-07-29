import { createPopout, type Popout } from "../usePopout";
import { useLayout } from "../useLayout";

/* The chat panel's pop-out window (an option in the tab strip's right-click menu) — a module-level singleton
 * like the rest of the layout/chat state. While popped out the shell collapses the chat grid column, and the
 * strip moves to the window's left edge (a real window is wide enough to spend 11rem on tabs; the docked
 * column is not). The floor keeps the window usable even when the docked panel is at its narrowest. */

const layout = useLayout();

const popout = createPopout(`chat`, `Intentic · Chat`, () => ({
    width: Math.max(layout.chatWidth.value, 720),
    height: Math.min(window.innerHeight, 900),
}));

export function useChatPopout(): Popout {
    return popout;
}
