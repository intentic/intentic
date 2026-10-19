// HOW MUCH ROOM THE REVIEW HAS, read off the review's own width rather than the window's: on a laptop the review shares
// the window with a preview, a docked chat and a terminal, and a file list beside a split diff in the ~440px that leaves
// wraps every line of code into fragments. Below the width a list and a readable diff need together, the list folds
// into one switcher row over the diff; with one file and nothing to narrow to, the row has nothing to switch and goes.
// The diff's own split/unified choice answers to its own width (DiffView), never by rewriting the stored preference.

// The review's width (rem) under which its file list stops standing beside the diff: a 15rem list beside a 30rem diff
// is about where both stay legible.
export const NARROW_REVIEW_REM = 45;

// `side`: the list beside the diff, as on any roomy screen. `switcher`: one row over the diff picks the file. `none`:
// a single file, which the diff's own toolbar already names, with its mark and counts.
export type ReviewListMode = `side` | `switcher` | `none`;

export const reviewListMode = (narrow: boolean, files: number, filters: number): ReviewListMode => {
    if (!narrow) {
        return `side`;
    }
    return files <= 1 && filters <= 1 ? `none` : `switcher`;
};

// What the review's list narrows to: conflicts, code or tests, what has not landed, or the committed work in history.
export type ReviewFilter = `all` | `blocked` | `code` | `tests` | `pending` | `history`;
