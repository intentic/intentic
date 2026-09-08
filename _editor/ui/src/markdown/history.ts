// Owns undo/redo because a `contenteditable`'s own stack breaks once this surface programmatically rewrites a
// block (a browser can't undo a `replaceChild`). History is whole-document snapshots, not patches, so undo can
// never leave the DOM and model disagreeing. A run of typing coalesces into one step; a kind change, a pause, a
// finished word or any structural edit each start a new one.

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

// Long enough that ordinary typing is one step, short enough that a pause to think starts another.
const COALESCE_MS = 600;

// How many whole-document snapshots undo keeps; bounded well inside what a tab already spends on the DOM.
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
        // Caret-only change (arrow key, click) isn't its own step, but the position is kept for the next real undo.
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
        // A new step discards any redo branch: that future no longer exists once the user has edited again.
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
