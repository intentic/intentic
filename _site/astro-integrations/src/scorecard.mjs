// @ts-check
// OpenSSF Scorecard for this repo, fetched from the public API at build time; fails to null on any error (no network,
// unpublished, API down, shape change) rather than render a wrong security number.

const API = `https://api.scorecard.dev/projects/github.com/intentic/intentic`;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ score: number, checks: { name: string, score: number }[], date: string, url: string }} Scorecard
 */

/**
 * The one read per build. Pages render concurrently (astro.config's `build.concurrency`), so the promise is what is kept:
 * a page that asks while another page's read is in flight waits for that read instead of being handed nothing.
 * @type {Promise<Scorecard | null> | undefined}
 */
let pending;

/**
 * The published Scorecard for this repo, or null if unreadable.
 * @returns {Promise<Scorecard | null>}
 */
export function scorecard() {
    pending ??= read();
    return pending;
}

/** @returns {Promise<Scorecard | null>} */
async function read() {
    try {
        const response = await fetch(API, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            console.warn(`[scorecard] ${API} answered ${response.status}: the site ships without its Scorecard figure`);
            return null;
        }
        const body = await response.json();
        // `score` is 0-10 with one decimal; any other shape is untrusted.
        if (typeof body?.score !== `number` || typeof body?.date !== `string`) {
            console.warn(`[scorecard] ${API} answered without a numeric score and a date: the site ships without its Scorecard figure`);
            return null;
        }
        return {
            score: body.score,
            checks: (body.checks ?? [])
                .filter((check) => typeof check?.score === `number`)
                .map((check) => ({ name: check.name, score: check.score })),
            // API returns a full ISO timestamp; keep only the date portion.
            date: body.date.split(`T`)[0],
            url: `https://scorecard.dev/viewer/?uri=github.com/intentic/intentic`,
        };
    } catch (error) {
        console.warn(`[scorecard] ${API} could not be read (${String(error)}): the site ships without its Scorecard figure`);
        return null;
    }
}
