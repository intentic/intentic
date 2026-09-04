// WHAT IS ACTUALLY IN THE UPDATE the /sandbox hub is offering, the user-facing lines from every release
// between this sandbox's own version and the newest one, for SandboxUpdateCard.
//
// The card has always been able to say that an update EXISTS and what it costs (recreating the container
// interrupts every agent mid-turn). It could not say what the update was worth, which left the only decision it
// asks for, take it now, or finish the run first, with nothing on one side of the scale.
//
// SOURCE IS THE PUBLISHED GITHUB RELEASE, deliberately, and not the npm packument version-check.ts reads: the
// notes are written into commits as `Release-Note:` trailers and harvested into the Release body at publish
// time (_tools/scripts/release/publish-github.sh), so the Release is where they exist. It is also the one copy anybody
// can FIX after the fact, nothing reviews these lines before they ship, and editing the Release body on GitHub
// corrects this card on its next refresh and the website on its next build.
//
// Same shape as version-check.ts beside it, for the same reasons: a background timer warms a cache, /info reads
// that cache synchronously, and every failure leaves the previous good value alone. A sandbox that cannot reach
// GitHub shows the update offer it always showed, without the notes.

import { isNewer } from "@intentic/sandbox-contract";
import { isDevBuild } from "../version.js";

const RELEASES_URL = "https://api.github.com/repos/intentic/intentic/releases?per_page=30";
// Matches version-check.ts: a moved release is not urgent, and this is one unauthenticated request per sandbox
// per hour against a 60/hour budget.
const REFRESH_MS = 60 * 60_000;

/* How many releases back to read. Thirty is ~ten days at the current rate, which covers the gap any sandbox
 * that checks in occasionally will have. A sandbox older than that gets the notes it can see plus the update
 * offer, which is strictly better than the nothing it had, and the website carries the full history. */

/* The most notes one card will show. A sandbox that has not been recreated in weeks would otherwise unroll
 * fifty bullets into a hub card, which nobody reads and which pushes everything under it off the screen. Past
 * this the card says how many more there are and sends the reader to the changelog. */
export const MAX_UPDATE_NOTES = 12;

interface ReleaseNotes {
    readonly version: string;
    readonly notes: readonly string[];
    readonly breaking: readonly string[];
}

let cached: readonly ReleaseNotes[] = [];

/* The bullets under one release-body heading, or none.
 *
 * DELIBERATELY A SECOND COPY of the parser in _site/site/src/lib/changelog.ts, on the same reasoning as
 * `markInitials` over there: the two consumers of these headings share no dependency edge, and one should not
 * be invented, a marketing site importing the sandbox contract, or the daemon importing the site, for
 * fifteen lines of string handling. The heading spellings are the contract publish-github.sh writes; keep the
 * three in step by hand. */
const sectionBullets = (body: string, heading: RegExp): string[] => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const notes: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        // The next heading of any level ends the section, "### Features" begins the commit-subject list.
        if (trimmed.startsWith("#")) {
            break;
        }
        if (trimmed.startsWith("- ")) {
            notes.push(trimmed.slice(2).trim());
        }
    }
    return notes.filter((note) => note !== "");
};

export const parseReleaseNotes = (body: string): string[] => sectionBullets(body, /^##\s+What's new\s*$/i);

// What a release TAKES AWAY, the `Breaking-Note:` trailers publish-github.sh files under their own heading.
// Kept apart from the notes end to end: these are the lines the update card must warn with, in full, before
// the update is taken.
export const parseBreakingNotes = (body: string): string[] => sectionBullets(body, /^##\s+Breaking changes\s*$/i);

/* Everything a sandbox on `installed` has not seen yet, newest release first, flattened into one list.
 *
 * Deduplicated ACROSS releases as well as within them: a note describing one change can ride several releases
 * when the work landed in pieces, and a card that says the same sentence three times reads as a bug in the card
 * rather than as three commits. Synchronous, cache-only, this is on the /info request path.
 *
 * An unknown installed version yields nothing rather than everything: that is the dev build (0.0.0), which
 * every release outranks, and it is exactly the sandbox that should not be told it is fifty releases behind. */
const collectSince = (installed: string | undefined, pick: (release: ReleaseNotes) => readonly string[]): string[] => {
    if (installed === undefined) {
        return [];
    }
    const seen = new Set<string>();
    const notes: string[] = [];
    for (const release of cached) {
        if (!isNewer(release.version, installed)) {
            continue;
        }
        for (const note of pick(release)) {
            const key = note.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                notes.push(note);
            }
        }
    }
    return notes;
};

export const updateNotes = (installed: string | undefined): string[] => collectSince(installed, (release) => release.notes);

// Every breaking sentence between `installed` and the newest release, deduplicated the same way. These are
// NEVER capped: MAX_UPDATE_NOTES exists so a hub card stays a card, but a warning that fell off the end of a
// truncated list is a user who took a breaking update unwarned.
export const breakingNotes = (installed: string | undefined): string[] => collectSince(installed, (release) => release.breaking);

interface GithubRelease {
    tag_name?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

// Fetch the recent releases once and update the cache. Never throws, any failure (offline, rate limit, shape
// change) keeps the previous value, and the card degrades to the offer it made before this existed.
export const refreshReleaseNotes = async (): Promise<void> => {
    try {
        const response = await fetch(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } });
        if (!response.ok) {
            return;
        }
        const releases = (await response.json()) as GithubRelease[];
        cached = releases
            .filter((release) => release.draft !== true && release.prerelease !== true)
            .flatMap((release) => {
                const { tag_name: tag, body } = release;
                if (typeof tag !== "string" || typeof body !== "string") {
                    return [];
                }
                const notes = parseReleaseNotes(body);
                const breaking = parseBreakingNotes(body);
                // A release with either section is worth caching: a break with no ordinary notes still has to
                // reach the card, and it is exactly the release that must not slip through unremarked.
                return notes.length === 0 && breaking.length === 0 ? [] : [{ version: tag.replace(/^v/, ""), notes, breaking }];
            });
    } catch {
        // Keep the previous cached value.
    }
};

// Boot-time background refresh (main.ts), mirroring startVersionCheck, including its dev-build skip: a dev
// build's 0.0.0 is never offered an update, so notes about one would have nowhere to go.
export const startReleaseNotesCheck = (): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshReleaseNotes();
    const timer = setInterval(() => void refreshReleaseNotes(), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
