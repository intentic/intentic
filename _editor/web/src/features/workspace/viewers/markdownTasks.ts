// Ticking a rendered checkbox, done to the source text: it stays available while a document is only being read, not
// edited.

// A task-list marker: the bullet, then `[ ]`/`[x]`, anchored per line; ordered items count too (`1. [ ] ...`).
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gmu;

/**
 * The document with its `index`-th task checkbox flipped, or undefined if there is no such checkbox. `index` counts
 * checkboxes in rendered order, the same order they appear in the source.
 */
export const toggleTaskCheckbox = (source: string, index: number): string | undefined => {
    TASK_MARKER.lastIndex = 0;
    for (let seen = 0; ; seen += 1) {
        const match = TASK_MARKER.exec(source);
        if (match === null) {
            return undefined;
        }
        if (seen === index) {
            const bullet = match[1] ?? ``;
            const ticked = (match[2] ?? ` `) !== ` `;
            const at = match.index + bullet.length;
            return `${source.slice(0, at)}[${ticked ? ` ` : `x`}]${source.slice(at + 3)}`;
        }
    }
};
