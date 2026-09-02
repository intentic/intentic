import type { CodeAnalysis } from "./analysis.js";
import { highlightLangFor } from "./lang-for-path.js";

/* HOW BIG A CHANGE IS ONCE THE COMMENTS ARE OUT OF IT, the +/− a review shows while its diffs are showing code
 * alone, which (useLayout.showComments being off by default) is what a reader sees before they touch anything.
 *
 * Git counts every line it changed, prose included, so on the default view every number in a review described a
 * diff nobody was being shown. That is not a rounding error: a row reading +26 −4 could open onto an empty pane,
 * and a file whose 40 added lines were 38 lines of comment was triaged as a big read and turned out to be
 * nothing. The rule this restores is that a number sits next to the thing it counts.
 *
 * The count comes off the SAME analysis the diff editor consumes, so the row and pane cannot disagree about what
 * a comment is. That worker-backed result is cached per text/language: review warming pays for each side once,
 * and opening the warmed diff reuses it.
 */

export interface LineStat {
    readonly additions: number;
    readonly deletions: number;
}

/* The table budget, past which the count is abandoned instead of paid for, the caller then shows git's numbers,
 * the same fallback a file with no grammar to strip takes. Only the differing MIDDLE of the two sides reaches the
 * table (the matching head and tail are trimmed off first), so an ordinary edit costs a few thousand cells and
 * this only ever fires on two large files with nothing in common. */
const MAX_CELLS = 1_000_000;

/* The lines of a side, COUNTED THE WAY GIT COUNTS THEM: a trailing newline terminates the last line, it does not
 * begin another one. Without that rule an added file came out one line bigger than git said it was — the split
 * leaves an empty element after the final newline, and on a file whose other side is empty there is nothing for
 * it to pair with, so it counted as a line of its own. On a modified file the phantom sat on both sides and
 * cancelled, which is exactly why it survived: it only ever showed up on the rows where the two readings were
 * supposed to differ most (see untrackedLineStats in the daemon, which has always counted this way). */
const splitLines = (text: string): string[] => {
    if (text === ``) {
        return [];
    }
    const lines = text.split(`\n`);
    if (lines.at(-1) === ``) {
        lines.pop();
    }
    return lines;
};

/* The LENGTH of the longest common subsequence: every line not on it is one a minimal diff reports, so this one
 * number yields both counts. The chat card's row builder (chatToolDiff) computes the same subsequence but has to
 * know WHICH lines pair up, and keeps a full table and a walk back through it to find out. Nothing here needs the
 * alignment, so the table is two rolling rows and there is no walk, which is what makes it affordable to run
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

/** One side read with its comments taken out, however the caller runs the walk: the app hands this off to a
 *  worker, the daemon runs it in-process. Undefined for a file whose grammar it has none of. */
export type Analyze = (text: string, lang: string | undefined) => Promise<CodeAnalysis | undefined>;

/** The same counts with every comment stripped from both sides, or undefined when this file cannot be stripped. */
export const codeLineStat = async (before: string, after: string, path: string, analyze: Analyze): Promise<LineStat | undefined> => {
    // The grammar the diff surface would tokenize this file with, resolved exactly as it resolves it, over the
    // highlight cap there is none, and the pane shows the file whole.
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === `` ? before : after);
    const [old, now] = await Promise.all([analyze(before, lang), analyze(after, lang)]);
    // Undefined is the pane's own fallback (it renders the file verbatim), so git's numbers are the true ones.
    if (old === undefined || now === undefined) {
        return undefined;
    }
    return lineStat(old.code.text, now.code.text);
};
