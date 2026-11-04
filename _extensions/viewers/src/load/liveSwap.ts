/* A document drawn again while it is being read: the agent rewrote the file the reader has open. Three things make
   that readable rather than a page that jumps back to its top on every write:

   - the new rendering is built off to the side and swapped in whole, so a failed parse leaves the last one standing
     (useViewerLoad's `stale`), and the reader's scroll position is put back after the swap;
   - the blocks whose text is new flash for a moment, so the eye finds what changed;
   - where the host asks to follow the edits (an ancestor carrying `data-follow-edits="true"`, set by the editor's
     FileViewer), the first changed block is scrolled into view.

   The editor's own text surfaces do the same for code and Markdown (CodeView, MarkdownViewer, through this module's
   `./live-swap` export); the attribute is the one contract between them, so a viewer needs nothing from the host's
   code. */

export const FOLLOW_ATTRIBUTE = `data-follow-edits`;

// The smallest units a reader sees as one piece of a document. Pictures stay out: their addresses are minted per
// render, so every one would read as new.
const BLOCKS = `p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, caption, dt, dd`;
// Past this share of blocks changed, the document was replaced rather than edited: nothing flashes, since everything
// would.
const MOST = 0.6;
const FLASH_MS = 2000;

// The innermost blocks under `root`, so a changed cell flashes rather than its whole table.
const leafBlocks = (root: ParentNode): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>(BLOCKS)].filter((block) => block.querySelector(BLOCKS) === null);

const keyOf = (block: HTMLElement): string => `${block.tagName}\n${(block.textContent ?? ``).trim()}`;

// Every block's text as it stands, to tell after a swap which blocks are new. A multiset, so a paragraph repeated
// twice and then three times counts one as new.
export const blockTexts = (root: ParentNode): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const block of leafBlocks(root)) {
        const key = keyOf(block);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
};

// The blocks under `root` whose text the earlier rendering did not have, in document order; empty blocks never count.
export const newBlocks = (before: ReadonlyMap<string, number>, root: ParentNode): HTMLElement[] => {
    const left = new Map(before);
    const found: HTMLElement[] = [];
    for (const block of leafBlocks(root)) {
        const key = keyOf(block);
        const count = left.get(key) ?? 0;
        if (count > 0) {
            left.set(key, count - 1);
        } else if ((block.textContent ?? ``).trim() !== ``) {
            found.push(block);
        }
    }
    return found;
};

// Every element from `from` up that is scrolled, with where it stands, and the way to put each back.
export const holdScroll = (from: HTMLElement): (() => void) => {
    const held: [HTMLElement, number, number][] = [];
    for (let node: HTMLElement | null = from; node !== null; node = node.parentElement) {
        if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
            held.push([node, node.scrollTop, node.scrollLeft]);
        }
    }
    return () => {
        for (const [node, top, left] of held) {
            node.scrollTop = top;
            node.scrollLeft = left;
        }
    };
};

// Whether the reader asked to be taken to each change as it lands.
export const followsEdits = (from: Element): boolean => from.closest(`[${FOLLOW_ATTRIBUTE}="true"]`) !== null;

// Lights the changed blocks and, when following, brings the first into view. `animate` is absent in a test DOM.
export const markChanged = (root: HTMLElement, changed: readonly HTMLElement[]): void => {
    const total = leafBlocks(root).length;
    if (changed.length === 0 || (total > 0 && changed.length / total > MOST)) {
        return;
    }
    for (const block of changed) {
        block.animate?.(
            [{ backgroundColor: `color-mix(in srgb, var(--warning, #f59e0b) 28%, transparent)` }, { backgroundColor: `transparent` }],
            { duration: FLASH_MS, easing: `ease-out` },
        );
    }
    if (followsEdits(root)) {
        changed[0]?.scrollIntoView?.({ block: `center`, behavior: `smooth` });
    }
};

/**
 * Puts what `build` drew into a detached element in place of `host`'s children, keeping the reader's scroll, and on a
 * refresh lights what changed. `build` throwing leaves `host` as it was, which is the point: a document caught
 * mid-write keeps showing its last good rendering. `build` answers false when a newer load took over, and nothing is
 * swapped.
 */
export const swapChildren = async (
    host: HTMLElement,
    build: (staging: HTMLElement) => Promise<boolean | void> | boolean | void,
    refresh: boolean,
): Promise<boolean> => {
    const staging = host.ownerDocument.createElement(`div`);
    if ((await build(staging)) === false) {
        return false;
    }
    const before = refresh ? blockTexts(host) : undefined;
    const restore = holdScroll(host);
    host.replaceChildren(...staging.childNodes);
    restore();
    if (before !== undefined) {
        markChanged(host, newBlocks(before, host));
    }
    return true;
};

/**
 * The lines of `after` an edit from `before` touched, 1-based and inclusive, from the first line that differs to the
 * last; undefined when nothing changed, or when most of the text did (a rewrite, not an edit, where lighting every line
 * says nothing). A deletion marks the line where the text closed up.
 */
export const changedLines = (before: string, after: string): { readonly first: number; readonly last: number } | undefined => {
    if (before === after) {
        return undefined;
    }
    const old = before.split(`\n`);
    const now = after.split(`\n`);
    let head = 0;
    while (head < old.length && head < now.length && old[head] === now[head]) {
        head += 1;
    }
    let tail = 0;
    while (tail < old.length - head && tail < now.length - head && old[old.length - 1 - tail] === now[now.length - 1 - tail]) {
        tail += 1;
    }
    const first = Math.min(head + 1, now.length);
    const last = Math.max(first, now.length - tail);
    return now.length > 1 && (last - first + 1) / now.length > MOST ? undefined : { first, last };
};
