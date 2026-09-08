// @ts-check
// The newest published release, read from the public API at build time, never typed (same rule as scorecard.mjs and
// git-stats.mjs). Fails to null on any error, since a page with no version is missing a detail, but one with a stale
// version lies about what you're installing.

const API = `https://api.github.com/repos/intentic/intentic/releases/latest`;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ version: string, date: string, notes: string }} LatestRelease
 */

/** @type {LatestRelease | null | undefined} */
let cached;

/**
 * The newest published release, or null when it cannot be read.
 * @returns {Promise<LatestRelease | null>}
 */
export async function latestRelease() {
    if (cached !== undefined) {
        return cached;
    }

    cached = null;
    try {
        const response = await fetch(API, {
            // Unauthenticated: sends a media type and caller id, GitHub's hardest-limited anonymous shape.
            headers: { accept: `application/vnd.github+json`, "user-agent": `intentic.dev-site-build` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            return cached;
        }
        const body = await response.json();
        // `tag_name` is `v1.15.1` (the .releaserc.json format); anything else means the tag scheme moved.
        const version = /^v(?<version>\d+\.\d+\.\d+.*)$/u.exec(body?.tag_name ?? ``)?.groups?.version;
        if (version === undefined || typeof body?.published_at !== `string`) {
            return cached;
        }
        cached = {
            version,
            // The day, not the timestamp: the same shape gitStats' `since` and scorecard's `date` use.
            date: body.published_at.split(`T`)[0],
            notes: body.html_url ?? `https://github.com/intentic/intentic/releases/latest`,
        };
    } catch {
    }
    return cached;
}
