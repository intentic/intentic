// @ts-check
/* This repository's OpenSSF Scorecard score, read from the public API at build time.
 *
 * Same rule as git-stats.mjs, and for the same reason: a security score is exactly the kind of number that
 * gets typed into a page once and then quietly stops being true. This one is not ours to type at all: it is
 * computed by a workflow we do not control, from checks we do not choose, and published on an API anyone can
 * query. The page renders whatever that API says, or it renders nothing.
 *
 * Fails to null on every path: no network in the build sandbox, the workflow has not published yet, the API
 * is down, the shape changed. A trust section that renders a wrong number is worse than one that renders a
 * sentence without one, and a *security* number that is wrong in our favour is worse still.
 */

const API = `https://api.scorecard.dev/projects/github.com/intentic/intentic`;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ score: number, checks: { name: string, score: number }[], date: string, url: string }} Scorecard
 */

/** @type {Scorecard | null | undefined} */
let cached;

/**
 * The published Scorecard for this repository, or null when it cannot be read.
 * @returns {Promise<Scorecard | null>}
 */
export async function scorecard() {
    if (cached !== undefined) {
        return cached;
    }

    cached = null;
    try {
        const response = await fetch(API, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            return cached;
        }
        const body = await response.json();
        // `score` is 0-10 with one decimal. Anything else means the shape moved and the number is not ours
        // to guess at.
        if (typeof body?.score !== `number` || typeof body?.date !== `string`) {
            return cached;
        }
        cached = {
            score: body.score,
            checks: (body.checks ?? [])
                .filter((check) => typeof check?.score === `number`)
                .map((check) => ({ name: check.name, score: check.score })),
            // The API answers with a full ISO timestamp; the page wants the day, the same shape gitStats
            // gives `since`.
            date: body.date.split(`T`)[0],
            url: `https://scorecard.dev/viewer/?uri=github.com/intentic/intentic`,
        };
    } catch {
        // Left at null: see the header.
    }
    return cached;
}
