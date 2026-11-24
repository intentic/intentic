// @ts-check
// How many people starred the repository, read from the public API at build time, never typed (same rule as
// latest-release.mjs and scorecard.mjs). Fails to null on any error: the GitHub mark then stands alone, since a missing
// count costs nothing and a stale or invented one is a claim the page cannot back.

const API = `https://api.github.com/repos/intentic/intentic`;
const TIMEOUT_MS = 5000;

/**
 * The one read per build, kept as the promise: every page's bar asks, and pages render concurrently.
 * @type {Promise<number | null> | undefined}
 */
let pending;

/**
 * The repository's stargazer count, or null when it cannot be read.
 * @returns {Promise<number | null>}
 */
export function githubStars() {
    pending ??= read();
    return pending;
}

/** @returns {Promise<number | null>} */
async function read() {
    try {
        // A token when the build has one (CI does), so the read is not spent against the anonymous hourly limit.
        /** @type {Record<string, string>} */
        const headers = { accept: `application/vnd.github+json`, "user-agent": `intentic.dev-site-build` };
        const token = process.env.GITHUB_TOKEN;
        if (token) {
            headers.authorization = `Bearer ${token}`;
        }
        const response = await fetch(API, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            console.warn(`[github-stars] ${API} answered ${response.status}: the GitHub mark ships without its star count`);
            return null;
        }
        const body = await response.json();
        const stars = body?.stargazers_count;
        // Number.isSafeInteger is false for anything that is not a number, so it is the whole shape check.
        if (!Number.isSafeInteger(stars) || stars < 0) {
            console.warn(`[github-stars] ${API} answered without a stargazers_count: the GitHub mark ships without its star count`);
            return null;
        }
        return stars;
    } catch (error) {
        console.warn(`[github-stars] ${API} could not be read (${String(error)}): the GitHub mark ships without its star count`);
        return null;
    }
}
