// A FILE THAT TAKES THE CARET THE MOMENT ITS EDITOR EXISTS: one the reader just created, named in the tree and opened by
// the same keystroke, where the next thing they do is type into it. The tree keeps its own focus on the new row (it has
// to, to finish the rename field), so without this the caret stayed in the tree and the first keystrokes went nowhere.
// One-shot and per path, and only for a while: an editor that mounts long after, or for the same path opened again
// later, comes up the way every file does.

const WINDOW_MS = 10_000;
const wanted = new Map<string, number>();

/** Asks the next editor that mounts for `path` to take the caret. */
export const requestCaret = (path: string, now: number = Date.now()): void => {
    wanted.set(path, now);
};

/** Whether the editor mounting for `path` should take the caret; yes at most once per request, and only while it is fresh. */
export const takeCaret = (path: string, now: number = Date.now()): boolean => {
    const at = wanted.get(path);
    wanted.delete(path);
    return at !== undefined && now - at < WINDOW_MS;
};
