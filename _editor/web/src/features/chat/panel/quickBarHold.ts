// What the parked chat's box and its transcript are doing, as one value only `stepQuickBar` moves (the way
// `advanceEdit` moves the tree's naming field). Each is closed, borrowed by a pointer that will take it back when it
// leaves, or kept by a press, the caret or a summons until the reader dismisses it. Timing is not in here: the
// component's hover clocks decide WHEN a hover or a leave counts, and this decides what it then does.

export type Hold = `closed` | `borrowed` | `kept`;

export interface QuickBar {
    readonly box: Hold;
    readonly peek: Hold;
}

export const CLOSED: QuickBar = { box: `closed`, peek: `closed` };

export type QuickBarEvent =
    // The box grows: borrowed by a hover that stayed or a summons, kept by a press that takes the caret. A question
    // waiting is answered where its card is drawn, so nothing opens for one; a box already open stays as it is.
    | { readonly kind: `open`; readonly keep: boolean; readonly asking: boolean }
    // The pointer's grace ran out: a borrowed box goes back, unless words in it hold it.
    | { readonly kind: `leave`; readonly words: boolean }
    // The same for the transcript, whose grace is shorter so it always folds first.
    | { readonly kind: `peekLeave` }
    // The eye: a hover borrows the transcript; a press keeps it (and the box), and a second press folds it.
    | { readonly kind: `peek`; readonly keep: boolean }
    // A press on the box's content keeps the box and whatever it is showing.
    | { readonly kind: `press` }
    // The caret came into the box.
    | { readonly kind: `focus` }
    // A press on the page under it, the one gesture meaning the reader went back: the transcript goes, and the box
    // unless it holds words, which it then holds only as long as a pointer would.
    | { readonly kind: `release`; readonly words: boolean }
    // One Escape undoes one thing: the transcript first, then the box.
    | { readonly kind: `escape` }
    // Minimize, the full chat, a surface with its own composer: everything folds at once.
    | { readonly kind: `fold` };

const open = (hold: Hold): boolean => hold !== `closed`;

export const stepQuickBar = (bar: QuickBar, event: QuickBarEvent): QuickBar => {
    switch (event.kind) {
        case `open`:
            if (event.asking) {
                return bar;
            }
            return { ...bar, box: event.keep ? `kept` : open(bar.box) ? bar.box : `borrowed` };
        case `leave`:
            return bar.box === `borrowed` && !event.words ? CLOSED : bar;
        case `peekLeave`:
            return bar.peek === `borrowed` ? { ...bar, peek: `closed` } : bar;
        case `peek`:
            if (!open(bar.box)) {
                return bar;
            }
            if (!event.keep) {
                return open(bar.peek) ? bar : { ...bar, peek: `borrowed` };
            }
            return bar.peek === `kept` ? { ...bar, peek: `closed` } : { box: `kept`, peek: `kept` };
        case `press`:
            return open(bar.box) ? { box: `kept`, peek: open(bar.peek) ? `kept` : `closed` } : bar;
        case `focus`:
            return open(bar.box) ? { ...bar, box: `kept` } : bar;
        case `release`:
            return event.words && open(bar.box) ? { box: `borrowed`, peek: `closed` } : CLOSED;
        case `escape`:
            return open(bar.peek) ? { ...bar, peek: `closed` } : CLOSED;
        case `fold`:
            return CLOSED;
    }
};
