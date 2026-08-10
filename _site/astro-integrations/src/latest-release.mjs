// @ts-check
/* The newest published release, read from the public API at build time — the version the download page is
 * about to hand somebody.
 *
 * Same rule as scorecard.mjs and git-stats.mjs: a number on a page that a person types is a number that
 * quietly stops being true, so this one is read from the thing it describes or it is not rendered at all.
 * The page keeps working either way — the download links never carry a version (the worker resolves that),
 * so this is the label on the button, not the button.
 *
 * Fails to null on every path: no network in the build sandbox, no release published yet, the API down, the
 * shape changed. A download page that renders no version is a page missing a detail; one that renders a
 * version older than the file behind the link is a page that lies about what you are installing.
 */

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
            // Unauthenticated, so ask for the documented media type and identify the caller — an anonymous
            // request with no Accept header is the shape GitHub rate-limits hardest.
            headers: { accept: `application/vnd.github+json`, "user-agent": `intentic.dev-site-build` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            return cached;
        }
        const body = await response.json();
        // `tag_name` is `v1.15.1` — the release tag format from .releaserc.json. Anything else means the tag
        // scheme moved and the version is not ours to guess at.
        const version = /^v(?<version>\d+\.\d+\.\d+.*)$/u.exec(body?.tag_name ?? ``)?.groups?.version;
        if (version === undefined || typeof body?.published_at !== `string`) {
            return cached;
        }
        cached = {
            version,
            // The day, not the full timestamp — the same shape gitStats gives `since` and scorecard gives
            // `date`, because a page saying "released at 14:07 UTC" is answering a question nobody asked.
            date: body.published_at.split(`T`)[0],
            notes: body.html_url ?? `https://github.com/intentic/intentic/releases/latest`,
        };
    } catch {
        // Left at null — see the header.
    }
    return cached;
}
