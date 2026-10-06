// User-facing lines from every release between this sandbox's version and the newest, for SandboxUpdateCard, and which
// releases were withdrawn after they shipped. Notes are harvested from `Release-Note:` commit trailers into the
// published GitHub release, not the npm packument. A background timer warms a cache; a failed refresh keeps the
// previous value.

import { isNewer, type WithdrawnRelease } from "@intentic/sandbox-contract";
import { isDevBuild } from "../../version.js";
import { RELEASE_FETCH_TIMEOUT_MS } from "./version-check.js";

const RELEASES_URL = "https://api.github.com/repos/intentic/intentic/releases?per_page=30";
// Matches version-check.ts: one unauthenticated request per sandbox per hour, against a 60/hour budget.
const REFRESH_MS = 60 * 60_000;

// Reads 30 releases back, about ten days at current rate; older sandboxes see what fits plus the update offer.

// Most notes one card shows before pointing the reader to the changelog instead of unrolling fifty bullets.
export const MAX_UPDATE_NOTES = 6;

export interface ReleaseNotes {
    readonly version: string;
    readonly notes: readonly string[];
    readonly breaking: readonly string[];
}

let cached: readonly ReleaseNotes[] = [];
// Releases taken back after they shipped, by version: what /info tells a sandbox that runs one.
let withdrawnReleases: ReadonlyMap<string, WithdrawnRelease> = new Map();

// The bullets under one release-body heading, or none. Deliberately duplicated from _site/site/src/lib/changelog.ts's
// parser rather than shared; keep heading spellings in step with publish-github.sh by hand.
const sectionBullets = (body: string, heading: RegExp): string[] => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const notes: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        // The next heading of any level ends the section; "### Features" begins the commit-subject list.
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

// What a release takes away: the `Breaking-Note:` trailers publish-github.sh files under their own heading. Kept apart
// from the notes end to end since these must reach the update card in full before the update is taken.
export const parseBreakingNotes = (body: string): string[] => sectionBullets(body, /^##\s+Breaking changes\s*$/i);

// Everything a sandbox on `installed` has not seen yet, newest first, deduplicated across releases in case a change
// landed in pieces. An unknown installed version (the dev build, 0.0.0) yields nothing.
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

// Every breaking sentence between `installed` and the newest release, deduplicated the same way; never capped, unlike
// MAX_UPDATE_NOTES.
export const breakingNotes = (installed: string | undefined): string[] => collectSince(installed, (release) => release.breaking);

// The running version's withdrawal, when the release pipeline took it back after it shipped; undefined while it stands,
// and until the first refresh has read the releases.
export const withdrawnRelease = (running: string): WithdrawnRelease | undefined => withdrawnReleases.get(running);

// Whether a release was withdrawn, and why: the release pipeline's rollback (rollback-stable.sh) writes a line
// `Withdrawn: <reason>` into the notes of the release it takes back, and marks it a pre-release so nobody is offered it.
// Undefined for a release still standing; a withdrawal that gives no reason is one all the same.
export const parseWithdrawn = (body: string): Omit<WithdrawnRelease, "version"> | undefined => {
    const line = body
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.startsWith("Withdrawn:"));
    if (line === undefined) {
        return undefined;
    }
    const reason = line.slice("Withdrawn:".length).trim();
    return reason === "" ? {} : { reason };
};

export interface GithubRelease {
    readonly tag_name?: unknown;
    readonly body?: unknown;
    readonly draft?: unknown;
    readonly prerelease?: unknown;
}

// What a page of releases says: the notes of each one offered, and each one withdrawn.
export interface ReleasesRead {
    readonly notes: ReleaseNotes[];
    readonly withdrawn: WithdrawnRelease[];
}

// A withdrawn release is read before the pre-release filter that would otherwise hide it (the rollback marks it one),
// and its notes are never offered: nobody is updated onto it.
export const readReleases = (releases: readonly GithubRelease[]): ReleasesRead => {
    const notes: ReleaseNotes[] = [];
    const withdrawn: WithdrawnRelease[] = [];
    for (const release of releases) {
        const { tag_name: tag, body } = release;
        if (release.draft === true || typeof tag !== "string" || typeof body !== "string") {
            continue;
        }
        const version = tag.replace(/^v/, "");
        const taken = parseWithdrawn(body);
        if (taken !== undefined) {
            withdrawn.push({ version, ...taken });
            continue;
        }
        if (release.prerelease === true) {
            continue;
        }
        const said = parseReleaseNotes(body);
        const breaking = parseBreakingNotes(body);
        // A release with either section is worth caching; a break with no notes must still reach the card.
        if (said.length > 0 || breaking.length > 0) {
            notes.push({ version, notes: said, breaking });
        }
    }
    return { notes, withdrawn };
};

// Fetches recent releases once and updates the cache. Never throws: any failure (offline, timed out, rate limit, shape
// change) keeps the previous value.
export const refreshReleaseNotes = async (): Promise<void> => {
    try {
        const response = await fetch(RELEASES_URL, {
            headers: { accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            return;
        }
        const read = readReleases((await response.json()) as GithubRelease[]);
        cached = read.notes;
        withdrawnReleases = new Map(read.withdrawn.map((release) => [release.version, release]));
    } catch {
        // Keeps the previous cached value on failure.
    }
};

// Boot-time background refresh (bootstrap/version-watches.ts), mirroring startVersionCheck including its dev-build skip: a dev build's 0.0.0
// is never offered an update, so its notes would have nowhere to go.
export const startReleaseNotesCheck = (): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshReleaseNotes();
    const timer = setInterval(() => void refreshReleaseNotes(), REFRESH_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
