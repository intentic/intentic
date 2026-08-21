// @ts-check
/* How often the creator's published libraries are actually installed, read from the npm registry's public
 * download API at build time.
 *
 * Same rule as git-stats.mjs, scorecard.mjs and latest-release.mjs: a number a person types is a number that
 * quietly stops being true. This one moves every day, and it is the whole reason /about/ lists these
 * libraries at all: "shipped and got used on their own" is a claim, and a download count is the evidence.
 * So it is read from the registry or it is not rendered, and the cards fall back to their sentences.
 *
 * A month rather than a week: weekly counts swing hard around weekends and holidays, and a reader comparing
 * four libraries wants the shape of the usage, not last Tuesday.
 *
 * Fails to null per package, never as a batch, so one unpublished or renamed name costs its own card a
 * figure and nothing else. No auth: this endpoint is open, and an anonymous build should not be holding a
 * token to render a public number.
 */

const API = `https://api.npmjs.org/downloads/point/last-month`;
const TIMEOUT_MS = 5000;

/** @type {Map<string, number | null>} */
const cache = new Map();

/**
 * Downloads in the last month for one package, or null when the registry cannot be read.
 * @param {string} name
 * @returns {Promise<number | null>}
 */
async function downloadsFor(name) {
    const hit = cache.get(name);
    if (hit !== undefined) {
        return hit;
    }

    /** @type {number | null} */
    let value = null;
    try {
        const response = await fetch(`${API}/${encodeURIComponent(name)}`, {
            headers: { accept: `application/json`, "user-agent": `intentic.dev-site-build` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) {
            const body = await response.json();
            // A package with no downloads answers 0, which is honest but reads as a broken counter, so it is
            // treated the same as no answer at all: the card keeps its sentence and loses its figure.
            if (typeof body?.downloads === `number` && body.downloads > 0) {
                value = body.downloads;
            }
        }
    } catch {
        // Left at null: see the header.
    }

    cache.set(name, value);
    return value;
}

/**
 * Last-month downloads for several packages at once, keyed by package name.
 * @param {readonly string[]} names
 * @returns {Promise<Record<string, number | null>>}
 */
export async function npmDownloads(names) {
    const counts = await Promise.all(names.map(async (name) => /** @type {const} */ ([name, await downloadsFor(name)])));
    return Object.fromEntries(counts);
}
