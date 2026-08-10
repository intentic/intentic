import { shallowRef } from "vue";
import { codeLineStat, type LineStat } from "./codeStat";

/* THE CODE-ONLY +/− A REVIEW SHOWS, per file, filled in as the diffs arrive.
 *
 * A row cannot work its own out: the count needs both sides of the file, and both sides are a daemon read. So the
 * count is a by-product instead — every path that reads a diff (the background reader walking a review's rows, the
 * file a reader just opened) hands what it read to `record`, and the rows read the answer back out of here.
 *
 * THREE STATES, NOT TWO, and that distinction is the whole point of this file. "I have not counted this yet" and
 * "this file has no comments to take out" are opposite answers that used to leave here as the same `undefined`,
 * so a surface could not tell them apart and printed git's number for both. For the second file that number is
 * exactly right and stays. For the first it is a number about a diff nobody is being shown, and it was replaced
 * the moment the file was read — which, because reading is what a click does, meant clicking a row visibly
 * changed the row you clicked, along with its heading and the panel's total. A count that moves is worse than a
 * count that is late: the reader has no way to know which of the two numbers they were supposed to believe. So
 * `counting` is now a state a badge can render as "not yet", and nothing prints a reading it is about to contradict.
 *
 * Keys are the caller's and must carry their scope (which agent, which repo, which side) — this is one store for
 * every review surface in the app, so a file read in two of them is tokenized once. */

/** What a file's +/− reads as with the comments out, for the badge that has to print one of them. */
export interface CodeCount {
    // The stripped counts. Absent means git's own are the honest reading — a file with no grammar to strip, bytes,
    // or a diff too big for the daemon to send: all three render whole, comments included.
    readonly code?: LineStat;
    // Still being worked out. No number can be stated yet, and none should be guessed at.
    readonly counting: boolean;
}

/* A file's content, small enough to keep. Kept so a file the agent has since written again is recounted rather
 * than answered with a number about the version before it — which is all the stored copy was ever for. It used to
 * be the two texts themselves, and this store outlives every panel: a session that reviewed a few agents held
 * every side of every file it had counted, in full, until the tab closed. Length and a rolling hash answer the
 * only question asked of them. */
const fingerprint = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${hash >>> 0}`;
};

interface Entry {
    // What the reading was taken from. Absent for a file there was nothing to read — bytes, or a diff the daemon
    // refused to send — where no later content can make the answer stale.
    readonly of?: string;
    // The stripped counts, or absent when this file has nothing to strip (see CodeCount.code).
    readonly code?: LineStat;
}

const stats = shallowRef<ReadonlyMap<string, Entry>>(new Map());
// Keys being tokenized right now, and the content that arrived for one while it was. Without the first, a row the
// background reader and a click reach in the same moment is counted twice; without the second, a file rewritten
// mid-count keeps the older version's number for as long as nobody opens it.
const running = new Set<string>();
const queued = new Map<string, { readonly path: string; readonly before: string; readonly after: string }>();

const COUNTING: CodeCount = { counting: true };

const fresh = (key: string, of: string): boolean => stats.value.get(key)?.of === of;

const settle = (key: string, entry: Entry): void => void (stats.value = new Map(stats.value).set(key, entry));

/** Count `key`'s change with the comments out of it, unless that has already been done for this exact content. */
const record = async (key: string, path: string, before: string, after: string): Promise<void> => {
    const of = `${fingerprint(before)}/${fingerprint(after)}`;
    if (fresh(key, of)) {
        return;
    }
    if (running.has(key)) {
        queued.set(key, { path, before, after });
        return;
    }
    running.add(key);
    try {
        // A failure lands as "nothing to strip" rather than staying absent: the grammar is not going to load on
        // the second ask either, so the honest answer is git's count — and a row left counting forever would keep
        // the review's totals pending on a file that is never going to answer.
        const code = await codeLineStat(before, after, path).catch(() => undefined);
        settle(key, code === undefined ? { of } : { of, code });
    } finally {
        running.delete(key);
    }
    const next = queued.get(key);
    if (next !== undefined) {
        queued.delete(key);
        await record(key, next.path, next.before, next.after);
    }
};

/** Settle `key` as a file with nothing to strip — bytes, or a diff too large to send. Git's counts are its reading. */
const noCode = (key: string): void => {
    const entry = stats.value.get(key);
    // Already written off. Re-settling would repaint every badge in every review for no change at all.
    if (entry !== undefined && entry.of === undefined) {
        return;
    }
    settle(key, {});
};

export function useCodeStats() {
    return {
        record,
        noCode,
        /** `key`'s reading: the stripped counts, git's own, or that it is still being worked out. */
        countOf: (key: string): CodeCount => {
            const entry = stats.value.get(key);
            if (entry === undefined) {
                return COUNTING;
            }
            return entry.code === undefined ? { counting: false } : { code: entry.code, counting: false };
        },
    };
}

/* A SPAN OF ROWS AS ONE READING — a package's heading, a repo's, the panel's total.
 *
 * Summed here rather than in each panel because the rule is subtle in one specific way: a file with nothing to
 * strip contributes GIT'S numbers, which for it are the code-only reading (its pane shows every line it has),
 * while a file still being counted contributes NOTHING AND POISONS THE TOTAL. A heading that added up the rows it
 * happened to know and printed the result was the worst number on the screen: it agreed with neither git nor its
 * own rows, and it changed every time the reader clicked one of them. */
export const sumCounts = (rows: readonly { readonly count: CodeCount; readonly additions?: number; readonly deletions?: number }[]): CodeCount => {
    let additions = 0;
    let deletions = 0;
    for (const row of rows) {
        if (row.count.counting) {
            return COUNTING;
        }
        additions += row.count.code?.additions ?? row.additions ?? 0;
        deletions += row.count.code?.deletions ?? row.deletions ?? 0;
    }
    return { code: { additions, deletions }, counting: false };
};
