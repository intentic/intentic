import { shallowRef } from "vue";
import { codeLineStat, type LineStat } from "./codeStat";

/* THE CODE-ONLY +/− A REVIEW SHOWS, per file, filled in as the diffs arrive.
 *
 * A row cannot work its own out: the count needs both sides of the file, and both sides are a daemon read — a
 * list of forty rows firing forty of them to print a number would have the review paying dearly for its own
 * header. So the count is a by-product instead. The surfaces that were ALREADY reading diffs — a review's
 * read-ahead, and the file the reader just opened — hand what they read to `record`, and the rows read the
 * answer back out of here.
 *
 * A row whose file has not been read yet shows git's number until it has. So does a file with no grammar to
 * strip, permanently, and that is the right answer for it: its pane shows the file whole, comments and all.
 * Both cases leave as the same `undefined`, because they are the same thing to a caller.
 *
 * Keys are the caller's and must carry their scope (which agent, which repo, which side) — this is one store for
 * every review surface in the app, so a file read in two of them is tokenized once. */

interface Entry {
    // What the stat was computed from, kept so a file the agent has since written again is recounted rather than
    // answered with a number about the version before it.
    readonly before: string;
    readonly after: string;
    readonly stat: LineStat | undefined;
}

interface Pending {
    readonly path: string;
    readonly before: string;
    readonly after: string;
}

const stats = shallowRef<ReadonlyMap<string, Entry>>(new Map());
// Keys being tokenized right now, and the content that arrived for one while it was. Without the first, a row
// warmed and clicked in the same moment is counted twice; without the second, a file rewritten mid-count keeps
// the older version's number for as long as nobody opens it.
const running = new Set<string>();
const queued = new Map<string, Pending>();

const fresh = (key: string, before: string, after: string): boolean => {
    const entry = stats.value.get(key);
    return entry !== undefined && entry.before === before && entry.after === after;
};

/** Count `key`'s change with the comments out of it, unless that has already been done for this exact content. */
const record = async (key: string, path: string, before: string, after: string): Promise<void> => {
    if (fresh(key, before, after)) {
        return;
    }
    if (running.has(key)) {
        queued.set(key, { path, before, after });
        return;
    }
    running.add(key);
    try {
        // A failure is recorded as no answer rather than left absent: the grammar is not going to load on the
        // second ask either, and a row that keeps re-asking on every render is worse than one showing git's count.
        const stat = await codeLineStat(before, after, path).catch(() => undefined);
        stats.value = new Map(stats.value).set(key, { before, after, stat });
    } finally {
        running.delete(key);
    }
    const next = queued.get(key);
    if (next !== undefined) {
        queued.delete(key);
        await record(key, next.path, next.before, next.after);
    }
};

export function useCodeStats() {
    return {
        record,
        /** `key`'s code-only counts, or undefined while they are unknown — the caller then shows git's own. */
        statOf: (key: string): LineStat | undefined => stats.value.get(key)?.stat,
    };
}
