import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";

/* READING THE DIFFS BEFORE THE READER ASKS FOR THEM.
 *
 * A review is a list you go down. The list arrives all at once; the diffs behind it arrive one daemon
 * round-trip at a time, each one paid for at the moment the reader clicks — which is the one moment they are
 * standing still waiting for it. Every one of those reads could have happened while they were scanning the list
 * deciding what to open, and none of them did.
 *
 * So the review reads ahead. When the change list settles, this walks it in the order the panel draws it and
 * pulls each row's diff into the cache; by the time a row is clicked the answer is usually already sitting
 * there, and the click paints in the same tick. A click on a row the walk is CURRENTLY reading costs nothing
 * either — both go through the same cached query, which hands the second caller the first one's request rather
 * than opening a new one.
 *
 * IT IS A TRICKLE, NOT A PREFETCH STORM, and the two rules that make it one are both here rather than in a
 * rate limiter:
 *   - ONE AT A TIME. The next row is not requested until the previous one has answered, so the daemon sees a
 *     single reader working down a list — which is exactly what it is — instead of forty simultaneous ones.
 *     That also means it self-throttles against a busy daemon for free: slow answers space the walk out.
 *   - ONLY WHEN THE BROWSER IS IDLE. Each step waits for an idle callback first, so the walk yields to
 *     rendering, to the reader's own clicks, and to a streaming turn's frames.
 * Nothing here retries and nothing here reports: a warm that fails is a warm that did not happen, and the click
 * that follows will make the same request for real and show the reader whatever went wrong.
 */

export interface WarmRow {
    readonly repo: string;
    readonly path: string;
    readonly side: GitDiffSide;
}

/* How far down the list one pass reads. A review is normally shorter than this, so the common case is "all of
 * it"; the cap is here for the ones that are not — a mass rename or a fresh clone ships hundreds of rows, and
 * reading every one of them would spend minutes of daemon time on files nobody is going to open. The rows past
 * it are not lost, only cold: clicking one costs exactly what clicking any row cost before this existed. */
export const WARM_LIMIT = 30;

// The panel's own reading order — conflicts first (they block the commit), then staged, then unstaged, repo by
// repo. Reading ahead in a different order than the list is drawn in would warm the rows the reader reaches
// last. Unscannable repos have no rows to read; the panel renders them as their error and nothing else.
const SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

export const warmRows = (repos: readonly RepoChanges[], limit: number = WARM_LIMIT): readonly WarmRow[] =>
    repos
        .filter((repo) => repo.error === undefined)
        .flatMap((repo) => SIDES.flatMap((side) => repo[side].map((change) => ({ repo: repo.repo, path: change.path, side }))))
        .slice(0, limit);

interface WarmPace {
    // True once this walk is obsolete — the list moved under it, or the panel went away. Checked after every
    // await, because both of those things happen while it is waiting rather than while it is running.
    readonly stopped: () => boolean;
    // Resolves when the browser has a moment. Injected so a test can step the walk without real idle time.
    readonly idle: () => Promise<void>;
}

/* Walk `rows`, reading each one, until they run out or the walk is abandoned. Returns what it warmed.
 *
 * Generic in the row because the two review surfaces name a file differently — the workspace's rows carry the
 * stage they came from, an agent's have no stages to carry — and the walk never looks inside one. The pacing is
 * the whole of what this owns, and it is the same pacing either way. */
export const warmDiffs = async <Row>(rows: readonly Row[], read: (row: Row) => Promise<unknown>, pace: WarmPace): Promise<readonly Row[]> => {
    const warmed: Row[] = [];
    for (const row of rows) {
        await pace.idle();
        if (pace.stopped()) {
            return warmed;
        }
        // A failed read is dropped on purpose — see the header. It leaves nothing cached, so the click that
        // follows re-reads it and reports the failure where the reader can act on it; and it is not counted as
        // warmed, because it isn't.
        const ok = await read(row).then(
            () => true,
            () => false,
        );
        if (pace.stopped()) {
            return warmed;
        }
        if (ok) {
            warmed.push(row);
        }
    }
    return warmed;
};

// The pace the browser actually runs at. Safari has no idle callback, so a beat of setTimeout stands in for it —
// the same bargain the chat transcript's warm-up makes.
const IDLE_FALLBACK_MS = 200;

export const whenIdle = (): Promise<void> =>
    new Promise((resolve) => {
        if (window.requestIdleCallback === undefined) {
            window.setTimeout(resolve, IDLE_FALLBACK_MS);
            return;
        }
        window.requestIdleCallback(() => resolve());
    });
