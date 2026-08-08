import { highlightLangFor } from "../../pages/workspace/fileType";
import { stripComments } from "./codeComments";

/* HOW BIG A CHANGE IS ONCE THE COMMENTS ARE OUT OF IT — the +/− a review shows while its diffs are showing code
 * alone, which (useLayout.showComments being off by default) is what a reader sees before they touch anything.
 *
 * Git counts every line it changed, prose included, so on the default view every number in a review described a
 * diff nobody was being shown. That is not a rounding error: a row reading +26 −4 could open onto an empty pane,
 * and a file whose 40 added lines were 38 lines of comment was triaged as a big read and turned out to be
 * nothing. The rule this restores is that a number sits next to the thing it counts.
 *
 * The count comes off the SAME stripped text the diff editor is handed (codeComments), so the row and the pane
 * cannot disagree about what a comment is. What it costs is a tokenize pass per side, which is why nothing here
 * runs on its own: callers feed it diffs they were already reading (see useCodeStats).
 */

export interface LineStat {
    readonly additions: number;
    readonly deletions: number;
}

/* The table budget, past which the count is abandoned instead of paid for — the caller then shows git's numbers,
 * the same fallback a file with no grammar to strip takes. Only the differing MIDDLE of the two sides reaches the
 * table (the matching head and tail are trimmed off first), so an ordinary edit costs a few thousand cells and
 * this only ever fires on two large files with nothing in common. */
const MAX_CELLS = 1_000_000;

const splitLines = (text: string): string[] => (text === `` ? [] : text.split(`\n`));

/* The LENGTH of the longest common subsequence: every line not on it is one a minimal diff reports, so this one
 * number yields both counts. The chat card's row builder (chatToolDiff) computes the same subsequence but has to
 * know WHICH lines pair up, and keeps a full table and a walk back through it to find out. Nothing here needs the
 * alignment, so the table is two rolling rows and there is no walk — which is what makes it affordable to run
 * over every file in a review rather than one card. */
const commonLength = (before: readonly string[], after: readonly string[]): number => {
    let previous = new Uint32Array(after.length + 1);
    let current = new Uint32Array(after.length + 1);
    for (let i = 1; i <= before.length; i++) {
        for (let j = 1; j <= after.length; j++) {
            current[j] = before[i - 1] === after[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
        }
        // Row i is finished; it becomes the row the next one reads from, and its buffer is overwritten in full
        // on the way (column 0 is zero for every row and is never written).
        [previous, current] = [current, previous];
    }
    return previous[after.length]!;
};

/** Added/removed line counts between two texts, or undefined when the two are too dissimilar to be worth diffing. */
export const lineStat = (before: string, after: string): LineStat | undefined => {
    const old = splitLines(before);
    const now = splitLines(after);
    // A matching head and tail belong to no change, and trimming them is what keeps the table small enough to
    // build: one edited function in a 2,000-line file leaves a middle of tens of lines.
    let start = 0;
    while (start < old.length && start < now.length && old[start] === now[start]) {
        start++;
    }
    let endOld = old.length;
    let endNow = now.length;
    while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) {
        endOld--;
        endNow--;
    }
    const removed = old.slice(start, endOld);
    const added = now.slice(start, endNow);
    if (removed.length * added.length > MAX_CELLS) {
        return undefined;
    }
    const common = commonLength(removed, added);
    return { additions: added.length - common, deletions: removed.length - common };
};

/** The same counts with every comment stripped from both sides, or undefined when this file cannot be stripped. */
export const codeLineStat = async (before: string, after: string, path: string): Promise<LineStat | undefined> => {
    // The grammar the diff surface would tokenize this file with, resolved exactly as it resolves it — over the
    // highlight cap there is none, and the pane shows the file whole.
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === `` ? before : after);
    const [old, now] = await Promise.all([stripComments(before, lang), stripComments(after, lang)]);
    // Undefined is the pane's own fallback (it renders the file verbatim), so git's numbers are the true ones.
    if (old === undefined || now === undefined) {
        return undefined;
    }
    return lineStat(old.text, now.text);
};
