// @ts-check
// How often the creator's published libraries are installed, read from npm's public download API at build time, never
// typed (same rule as git-stats.mjs, scorecard.mjs, latest-release.mjs). A month, not a week, to avoid weekend/holiday
// swings; fails to null per package, so one bad name doesn't cost the others their figure.

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
            // A real zero reads as broken, treated as no answer: keep the sentence, drop the figure.
            if (typeof body?.downloads === `number` && body.downloads > 0) {
                value = body.downloads;
            }
        }
    } catch {
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
