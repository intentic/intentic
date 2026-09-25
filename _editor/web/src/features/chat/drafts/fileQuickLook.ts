import { formatOf } from "@intentic/ui/file-format";

// What a look at an attached file IS; no fetching and no client (the share page draws it), attachmentQuickLooks.ts fetches.

// Anything that is neither a picture nor sound is a file chip with a text look.
export const isImagePath = (path: string): boolean => formatOf(path).category === `image`;
export const isAudioPath = (path: string): boolean => formatOf(path).category === `audio`;

export interface FileQuickLook {
    // False when the daemon answered that nothing is at the path: an attachment whose bytes were cleaned up.
    readonly present: boolean;
    // The whole file's size, from the daemon's own stat, not the length of the window below.
    readonly size: number;
    // The file's first lines; empty for a binary or missing file.
    readonly head: string;
    // Bytes the head window carried. Equal to `size` when the head IS the whole file, which is what `quickLookLines` needs.
    readonly headBytes: number;
    // The file's last lines, present only when the head didn't reach the end; never overlaps the head.
    readonly tail?: string;
    readonly tailBytes: number;
    // NUL in the first window: the text route utf8-decoded bytes that aren't text, so no lines are drawn from them.
    readonly binary: boolean;
}

// Windows are cut on byte counts, not line breaks, so each end carries a fragment of a line that would draw as if it
// were a whole one. Dropped rather than shown — except where there is no break at all, which is one long line, not a
// fragment.
export const dropPartialLast = (text: string): string => (text.includes(`\n`) ? text.slice(0, text.lastIndexOf(`\n`)) : text);
export const dropPartialFirst = (text: string): string => text.slice(text.indexOf(`\n`) + 1);

// Lines in the whole file, countable only when the head window reached the end; a clipped head knows how many lines
// IT holds, which is not a fact about the file.
export const quickLookLines = (look: FileQuickLook): number | undefined => {
    if (!look.present || look.binary || look.headBytes < look.size) {
        return undefined;
    }
    return look.head === `` ? 0 : look.head.replace(/\n$/, ``).split(`\n`).length;
};

// Bytes neither window quotes: what the card's separator names, and the reason it is there at all.
export const quickLookOmitted = (look: FileQuickLook): number => Math.max(0, look.size - look.headBytes - look.tailBytes);

// The chip's lines: the head's first non-blank ones, which is what identifies a log or a config at a glance (a
// leading blank line or a comment banner would otherwise spend the whole preview).
export const quickLookLead = (look: FileQuickLook, count: number): readonly string[] =>
    look.head
        .split(`\n`)
        .map((line) => line.trimEnd())
        .filter((line) => line !== ``)
        .slice(0, count);
