// @ts-check
// The newest published release, read from the public API at build time, never typed (same rule as scorecard.mjs and
// git-stats.mjs). Fails to null on any error, since a page with no version is missing a detail, but one with a stale
// version lies about what you're installing.

const API = `https://api.github.com/repos/intentic/intentic/releases/latest`;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ version: string, date: string, notes: string }} LatestRelease
 */

/**
 * The one read per build. Pages render concurrently (astro.config's `build.concurrency`), so the promise is what is kept:
 * a page that asks while another page's read is in flight waits for that read instead of being handed nothing.
 * @type {Promise<LatestRelease | null> | undefined}
 */
let pending;

/**
 * The newest published release, or null when it cannot be read.
 * @returns {Promise<LatestRelease | null>}
 */
export function latestRelease() {
    pending ??= read();
    return pending;
}

/** @returns {Promise<LatestRelease | null>} */
async function read() {
    try {
        const response = await fetch(API, {
            // Unauthenticated: sends a media type and caller id, GitHub's hardest-limited anonymous shape.
            headers: { accept: `application/vnd.github+json`, "user-agent": `intentic.dev-site-build` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            console.warn(`[latest-release] ${API} answered ${response.status}: the download page ships without its version line`);
            return null;
        }
        const body = await response.json();
        // `tag_name` is `v1.15.1` (the .releaserc.json format); anything else means the tag scheme moved.
        const version = /^v(?<version>\d+\.\d+\.\d+.*)$/u.exec(body?.tag_name ?? ``)?.groups?.version;
        if (version === undefined || typeof body?.published_at !== `string`) {
            console.warn(`[latest-release] ${API} answered a release with no v<semver> tag or no date: the download page ships without its version line`);
            return null;
        }
        return {
            version,
            // The day, not the timestamp: the same shape gitStats' `since` and scorecard's `date` use.
            date: body.published_at.split(`T`)[0],
            notes: body.html_url ?? `https://github.com/intentic/intentic/releases/latest`,
        };
    } catch (error) {
        console.warn(`[latest-release] ${API} could not be read (${String(error)}): the download page ships without its version line`);
        return null;
    }
}
