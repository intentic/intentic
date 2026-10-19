import { ref } from "vue";
import { useLayout } from "./useLayout";

// FOCUS REVIEW: the review given the window. On a laptop the section shares its width with what was opened beside it,
// the docked chat and the terminal, and a twenty-line diff in the ~440px that leaves wraps into fragments. Focus hides
// the side panel (what was opened beside and a side-docked chat alike) and closes the docked terminal, and its exit
// puts exactly that back: the side panel is only hidden, never closed (its tabs, its chat, a running preview stay
// mounted), and the terminal reopens only if focus is what closed it. Nothing here is a preference: a reload, or
// leaving the review, ends it.

// allow(module-state): one window's arrangement for as long as one review is on screen; no sandbox owns it
export const reviewFocused = ref(false);
// Whether entering focus closed the docked terminal, so exiting reopens it and nothing else.
let closedTerminal = false;

export const enterReviewFocus = (): void => {
    if (reviewFocused.value) {
        return;
    }
    const layout = useLayout();
    closedTerminal = layout.terminalOpen.value;
    if (closedTerminal) {
        layout.setTerminalOpen(false);
    }
    reviewFocused.value = true;
};

export const exitReviewFocus = (): void => {
    if (!reviewFocused.value) {
        return;
    }
    reviewFocused.value = false;
    const layout = useLayout();
    // Opened again during focus, it is already where the reader wants it.
    if (closedTerminal && !layout.terminalOpen.value) {
        layout.setTerminalOpen(true);
    }
    closedTerminal = false;
};

export const toggleReviewFocus = (): void => (reviewFocused.value ? exitReviewFocus() : enterReviewFocus());
