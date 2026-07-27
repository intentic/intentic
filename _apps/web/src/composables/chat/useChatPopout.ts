import { createPopout, type Popout } from "../usePopout";
import { useLayout } from "../useLayout";

/* The chat panel's pop-out window (an option in the tab strip's right-click menu) — a module-level singleton
 * like the rest of the layout/chat state. While popped out the shell collapses the chat grid column. */

const layout = useLayout();

const popout = createPopout(() => ({ width: layout.chatWidth.value, height: Math.min(window.innerHeight, 900) }));

export function useChatPopout(): Popout {
    return popout;
}
