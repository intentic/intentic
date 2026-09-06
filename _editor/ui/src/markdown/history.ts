/* UNDO AND REDO FOR THE MARKDOWN DOCUMENT SURFACE, which has to own them because the browser cannot.
 *
 * A `contenteditable` keeps its own undo stack, and it is a good one: it knows what the user typed and can put
 * it back. It only works, though, while the browser is the only thing editing the DOM. This surface parses each
 * edit and REBUILDS the block it changed (an asterisk just typed has to become a marker, and the word beside it
 * bold), and a programmatic replaceChild is not something the browser can undo: the stack is dropped on the
 * first keystroke, and Ctrl+Z does nothing for the rest of the session. That is the bug this fixes.
 *
 * So history is kept here instead, over the one thing that matters and is cheap to hold: the document's SOURCE.
 * Each entry is a whole text plus where the caret was in it. A markdown file that is too big for this surface to
 * render at all is capped long before a few hundred copies of it are a memory concern (PROSE_MAX_CHARS), and
 * whole strings mean an undo can never leave the DOM and the model disagreeing, which a stack of patches over a
 * surface the browser is also mutating eventually would.
 *
 * WHAT ONE PRESS UNDOES is the whole point of the coalescing below, and getting it wrong is what makes an editor
 * feel broken in either direction: one press per character is exhausting, one press for the whole session is
 * frightening. A run of typing collapses into a single entry, and a run ends when
 *
 *   the kind of edit changes, so inserting and deleting are never undone together,
 *   the user pauses, because a pause is where they stopped to think, or
 *   a word is finished, so Ctrl+Z takes back the last word rather than the last paragraph, and
 *   anything structural happens (Enter, a paste, two blocks joined, a formatting shortcut), which is always
 *   its own step because it is always one deliberate act.
 *
 * The clock is passed IN rather than read here, so the rules above are testable without waiting. */

export type EditKind = "typing" | "deleting" | "structural";

export interface DocumentState {
    readonly text: string;
    /** Where the caret sat in this text. An undo restores the position as well as the words. */
    readonly caret: number;
}

export interface MarkdownHistory {
    /** Start again from `state`, forgetting everything: a different file, or one reloaded from disk. */
    readonly reset: (state: DocumentState) => void;
    /** Note that the document is now `state`, arrived at by an edit of kind `kind` at time `at` (ms). */
    readonly record: (state: DocumentState, kind: EditKind, at: number) => void;
    /** The state before the last step, or undefined at the beginning of history. */
    readonly undo: () => DocumentState | undefined;
    /** The state after the current one, or undefined when nothing has been undone. */
    readonly redo: () => DocumentState | undefined;
}

// Long enough that ordinary typing is one step, short enough that stopping to think starts another. The number
// editors converge on; nothing here depends on its exact value.
const COALESCE_MS = 600;

/* How many documents deep undo goes. Each entry is a whole copy of the source, and the surface refuses to render
 * anything over 256 KiB at all, so the worst case is bounded well inside what a tab already spends on the DOM. */
const LIMIT = 200;

// A run of typing ends at the end of a word, so one press takes back one word.
const finishedAWord = (state: DocumentState): boolean => /\s/u.test(state.text.slice(Math.max(0, state.caret - 1), state.caret));

export const createMarkdownHistory = (): MarkdownHistory => {
    let entries: DocumentState[] = [];
    let index = -1;
    // What the run in progress is made of, and when it was last added to. Cleared to break the run.
    let runKind: EditKind | undefined;
    let runAt = 0;

    const reset = (state: DocumentState): void => {
        entries = [state];
        index = 0;
        runKind = undefined;
        runAt = 0;
    };

    const record = (state: DocumentState, kind: EditKind, at: number): void => {
        const current = entries[index];
        if (current === undefined) {
            reset(state);
            return;
        }
        /* The caret moved but the words did not (an arrow key, a click). Not a step of its own: an undo that only
         * put the cursor back would read as Ctrl+Z having failed. The position is kept, though, so that when a
         * real edit IS undone the caret returns to where the user was rather than to where they last typed. */
        if (current.text === state.text) {
            entries[index] = state;
            return;
        }
        const continues = kind !== `structural` && kind === runKind && at - runAt <= COALESCE_MS;
        runKind = finishedAWord(state) ? undefined : kind;
        runAt = at;
        if (continues) {
            entries[index] = state;
            return;
        }
        // A new step. Anything that had been undone is now unreachable, which is what every editor does: the
        // redo branch belonged to a future the user has just replaced.
        entries = [...entries.slice(0, index + 1), state];
        if (entries.length > LIMIT) {
            entries = entries.slice(entries.length - LIMIT);
        }
        index = entries.length - 1;
    };

    const step = (to: number): DocumentState | undefined => {
        const next = entries[to];
        if (next === undefined) {
            return undefined;
        }
        index = to;
        // Whatever run was in progress is over: typing after an undo must not be folded into the step before it.
        runKind = undefined;
        return next;
    };

    return {
        reset,
        record,
        undo: () => (index > 0 ? step(index - 1) : undefined),
        redo: () => (index < entries.length - 1 ? step(index + 1) : undefined),
    };
};
