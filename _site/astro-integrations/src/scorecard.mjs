// @ts-check
// OpenSSF Scorecard for this repo, fetched from the public API at build time; fails to null on any error (no network,
// unpublished, API down, shape change) rather than render a wrong security number.

const API = `https://api.scorecard.dev/projects/github.com/intentic/intentic`;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ score: number, checks: { name: string, score: number }[], date: string, url: string }} Scorecard
 */

/** @type {Scorecard | null | undefined} */
let cached;

/**
 * The published Scorecard for this repo, or null if unreadable.
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
        // `score` is 0-10 with one decimal; any other shape is untrusted.
        if (typeof body?.score !== `number` || typeof body?.date !== `string`) {
            return cached;
        }
        cached = {
            score: body.score,
            checks: (body.checks ?? [])
                .filter((check) => typeof check?.score === `number`)
                .map((check) => ({ name: check.name, score: check.score })),
            // API returns a full ISO timestamp; keep only the date portion.
            date: body.date.split(`T`)[0],
            url: `https://scorecard.dev/viewer/?uri=github.com/intentic/intentic`,
        };
    } catch {
    }
    return cached;
}
