// A document's two versions as one text with tracked changes, the way a word processor shows them: paragraphs are
// matched first, then the words inside a changed paragraph. Pure, so the view only draws. The edit scripts
// themselves are the kit's (`@intentic/ui/diff`), shared with the table diff and the viewers' redlines.
import { diffSequence, pairEdits, type Segment as ProseSegment, type SegmentKind, similarityOf, wordDiff } from "@intentic/ui/diff";

export type { ProseSegment };

export type BlockKind = "same" | "changed" | "added" | "removed";

export interface ProseBlock {
    readonly kind: BlockKind;
    // A markdown heading's level, with its hashes already stripped from the segments; absent for a paragraph.
    readonly heading?: number;
    readonly segments: readonly ProseSegment[];
}

const HEADING = /^(#{1,6})\s+/;

// Splits a heading's hashes off, so the view can size the line and the words diffed are the words.
const shape = (block: string): { heading?: number; text: string } => {
    const match = HEADING.exec(block);
    return match === null ? { text: block } : { heading: match[1]!.length, text: block.slice(match[0].length) };
};

// Paragraphs: runs of lines separated by a blank line, whitespace trimmed at both ends, line endings normalised.
export const blocksOf = (text: string): string[] =>
    text
        .replace(/\r\n/g, `\n`)
        .split(/\n[ \t]*\n+/)
        .map((block) => block.trim())
        .filter((block) => block !== ``);

const whole = (kind: BlockKind, block: string): ProseBlock => {
    const { heading, text } = shape(block);
    const segmentKind: SegmentKind = kind === `added` ? `added` : kind === `removed` ? `removed` : `same`;
    return { kind, ...(heading === undefined ? {} : { heading }), segments: [{ kind: segmentKind, text }] };
};

// Below this share of common words, a removed paragraph and the added one after it are two paragraphs, not one
// edited: worded, they would read as a soup of marks over neither.
export const ALIKE = 0.4;

export const proseDiff = (before: string, after: string): ProseBlock[] => {
    const blocksBefore = blocksOf(before);
    const blocksAfter = blocksOf(after);
    const ops = diffSequence(blocksBefore, blocksAfter, (left, right) => left === right);
    if (ops === undefined) {
        return [...blocksBefore.map((block) => whole(`removed`, block)), ...blocksAfter.map((block) => whole(`added`, block))];
    }
    // Each pair's word diff, kept from the likeness test for drawing, which would otherwise diff the pair a second time.
    const worded = new Map<string, Map<string, ProseSegment[]>>();
    const wordsOf = (removed: string, added: string): ProseSegment[] => {
        let byAdded = worded.get(removed);
        if (byAdded === undefined) {
            byAdded = new Map();
            worded.set(removed, byAdded);
        }
        let segments = byAdded.get(added);
        if (segments === undefined) {
            segments = wordDiff(shape(removed).text, shape(added).text);
            byAdded.set(added, segments);
        }
        return segments;
    };
    const alike = (removed: string, added: string): boolean => similarityOf(shape(removed).text, shape(added).text, wordsOf(removed, added)) >= ALIKE;
    // A paragraph paired with its edited self is diffed word by word; the heading level is the new one's.
    const changed = (removed: string, added: string): ProseBlock => {
        const heading = shape(added).heading ?? shape(removed).heading;
        return { kind: `changed`, ...(heading === undefined ? {} : { heading }), segments: wordsOf(removed, added) };
    };
    return pairEdits(ops, alike).map((edit) => (edit.kind === `pair` ? changed(edit.before, edit.after) : edit.kind === `same` ? whole(`same`, edit.after) : whole(edit.kind, edit.item)));
};

// What the view draws: every changed block, with a little unchanged context on each side, and the long unchanged runs
// between folded into one line that says how many paragraphs it stands for.
export type ProseRun = { readonly kind: "block"; readonly block: ProseBlock } | { readonly kind: "fold"; readonly count: number; readonly at: number };

const CONTEXT = 1;

const shown = (blocks: readonly ProseBlock[], from: number, to: number): ProseRun[] => blocks.slice(from, to).map((block) => ({ kind: `block`, block }));

// One unchanged run [from, to): context at each edge that touches a change, and a fold for the middle, which only
// earns its line when it hides more than the line would show.
const foldRun = (blocks: readonly ProseBlock[], from: number, to: number): ProseRun[] => {
    const lead = from === 0 ? 0 : CONTEXT;
    const tail = to === blocks.length ? 0 : CONTEXT;
    const hidden = to - from - lead - tail;
    if (hidden <= 1) {
        return shown(blocks, from, to);
    }
    return [...shown(blocks, from, from + lead), { kind: `fold`, count: hidden, at: from + lead }, ...shown(blocks, to - tail, to)];
};

export const foldUnchanged = (blocks: readonly ProseBlock[]): ProseRun[] => {
    if (!blocks.some((block) => block.kind !== `same`)) {
        return shown(blocks, 0, blocks.length);
    }
    const runs: ProseRun[] = [];
    let index = 0;
    while (index < blocks.length) {
        let end = index;
        while (end < blocks.length && blocks[end]!.kind === `same`) {
            end++;
        }
        if (end === index) {
            runs.push({ kind: `block`, block: blocks[index]! });
            index++;
        } else {
            runs.push(...foldRun(blocks, index, end));
            index = end;
        }
    }
    return runs;
};
