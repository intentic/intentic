import { createFloatingSurface, type FloatingSurface } from "../../../shell/window/floating";
import { toScreenPx } from "../../../shell/window/uiScale";
import { useLayout } from "../../../shell/window/useLayout";

// The chat panel's own floating window (chat bar button plus right-click row), a module singleton; it renders the panel
// at /floating/chat. While it floats, every other window collapses its chat column, and a wide panel turns onto its
// side so the chat list becomes a permanent left rail instead of a sheet.

const layout = useLayout();

const surface = createFloatingSurface(`chat`, () => ({
    // Width converts docked chatWidth to screen pixels; the floor (Tailwind's `lg`) is this window's own minimum, since
    // it reads breakpoints against its own viewport. Dragging narrower afterward is still allowed.
    width: Math.max(toScreenPx(layout.chatWidth.value), 1024),
    height: Math.min(window.innerHeight, 900),
}));

export function useChatFloating(): FloatingSurface {
    return surface;
}
