import { createFloatingSurface, type FloatingSurface } from "../../../workbench/window/floating";
import { toScreenPx } from "../../../workbench/window/uiScale";
import { useLayout } from "../../../workbench/window/useLayout";

// The chat panel's own floating window (chat bar button plus right-click row), a module singleton; it renders the panel
// at /floating/chat, the Agents board on its left (shell/window/FloatingBoard.vue). While it floats, every other window
// collapses its chat column.

const layout = useLayout();

const surface = createFloatingSurface(`chat`, () => ({
    // Width converts docked chatWidth to screen pixels, with room for the board beside it; the floor (Tailwind's `xl`)
    // keeps both a column, and is above `lg` since the window reads breakpoints against its own viewport. Dragging
    // narrower afterward is still allowed.
    width: Math.max(toScreenPx(layout.chatWidth.value) * 2, 1280),
    height: Math.min(window.innerHeight, 900),
}));

export function useChatFloating(): FloatingSurface {
    return surface;
}
