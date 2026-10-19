import { enterReviewFocus, exitReviewFocus, reviewFocused, toggleReviewFocus } from "./reviewFocus";
import { useLayout } from "./useLayout";

// Pins that Focus review closes only what it can put back, and that its exit restores exactly the arrangement it
// found: the docked terminal reopens only if focus closed it, and a terminal opened during focus stays open.

const layout = useLayout();

afterEach(() => {
    exitReviewFocus();
    layout.setTerminalOpen(false);
});

describe(`focus review`, () => {
    it(`closes an open terminal for the review and reopens it on exit`, () => {
        layout.setTerminalOpen(true);
        enterReviewFocus();
        expect([reviewFocused.value, layout.terminalOpen.value]).toEqual([true, false]);
        exitReviewFocus();
        expect([reviewFocused.value, layout.terminalOpen.value]).toEqual([false, true]);
    });

    it(`leaves a closed terminal closed on exit`, () => {
        toggleReviewFocus();
        toggleReviewFocus();
        expect([reviewFocused.value, layout.terminalOpen.value]).toEqual([false, false]);
    });

    it(`keeps a terminal the reader opened during focus`, () => {
        enterReviewFocus();
        layout.setTerminalOpen(true);
        exitReviewFocus();
        expect(layout.terminalOpen.value).toBe(true);
    });

    it(`does nothing on a second enter, so the first one's memory of the terminal stands`, () => {
        layout.setTerminalOpen(true);
        enterReviewFocus();
        enterReviewFocus();
        exitReviewFocus();
        expect(layout.terminalOpen.value).toBe(true);
    });
});
