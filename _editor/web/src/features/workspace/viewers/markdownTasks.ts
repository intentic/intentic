/* Ticking a box in a rendered markdown document.
 *
 * The one edit a READER makes. It is a fact about the work rather than a change to the prose, every other
 * checklist in the app is clickable, and the plans agents write here are mostly checklists, so it stays
 * available while the document is merely being read rather than edited. Same line VS Code's markdown editor
 * draws: its rendered controls keep working in read-only mode, and only typing is refused.
 *
 * Done to the SOURCE rather than to the rendered checkbox, because the file is what anyone else will read. */

/* A task-list marker: the bullet, then its `[ ]` or `[x]`. Anchored per line, so a `[x]` sitting in the middle
 * of a sentence is prose and stays prose. Ordered items count too: `1. [ ] ship it` is a task list in GFM. */
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gmu;

/**
 * The document with its `index`-th task checkbox flipped, or undefined when there is no such checkbox.
 *
 * `index` counts the checkboxes the RENDERER drew, in document order, which is the same order they appear in the
 * source: the caller finds it by position among the rendered inputs.
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
