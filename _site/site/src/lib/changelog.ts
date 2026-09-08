import { githubReleasesUrl } from "@intentic/site-content/site";

// Changelog data, read at build time from published GitHub Releases; the release body (`Release-Note:`/`Breaking-Note:`
// commit trailers) is the single source, so editing it on GitHub fixes this page and the sandbox update card. No
// fallback copy: a failed read says so instead of showing stale notes.

const RELEASES_API = "https://api.github.com/repos/intentic/intentic/releases?per_page=100";

// Headings publish-github.sh writes; everything under one until the next heading is that section's lines.
const WHATS_NEW_HEADING = /^##\s+What's new\s*$/i;
const BREAKING_HEADING = /^##\s+Breaking changes\s*$/i;

const naturalPunctuation = (text: string): string =>
    text
        .replace(/ \u2014 (and|or|but|which|while) /g, ", $1 ")
        .replace(/ \u2014 so /g, ". So ")
        .replace(/ \u2014 because /g, " because ")
        .replace(/ \u2014 /g, ": ")
        .replace(/\u2014/g, ":");

export interface ChangelogEntry {
    /** The plain release version, no `v`: what the app reports as its own and compares against. */
    version: string;
    /** ISO 8601, for the dateline and for `<time datetime>`. */
    publishedAt: string;
    /** This release's page on GitHub, where the full technical notes and the downloads are. */
    url: string;
    /** The user-facing lines, in the order the release lists them; never empty in a returned entry. */
    notes: string[];
    /** What this release takes away: the "Breaking changes" lines. Empty for almost every release. */
    breaking: string[];
}

// Bullets under a heading (`- ` lines), matched against exactly the shape publish-github.sh emits, not parsed as
// general markdown; no matching section yields nothing, keeping the release off the page.
const sectionBullets = (body: string, heading: RegExp): string[] => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const notes: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        // Any heading, at any level, ends the section.
        if (trimmed.startsWith("#")) {
            break;
        }
        if (trimmed.startsWith("- ")) {
            notes.push(naturalPunctuation(trimmed.slice(2).trim()));
        }
    }
    return notes.filter((note) => note !== "");
};

const parseNotes = (body: string): string[] => sectionBullets(body, WHATS_NEW_HEADING);
const parseBreaking = (body: string): string[] => sectionBullets(body, BREAKING_HEADING);

interface GithubRelease {
    tag_name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

const toEntry = (release: GithubRelease): ChangelogEntry | undefined => {
    const { tag_name: tag, body, html_url: url, published_at: publishedAt } = release;
    if (typeof tag !== "string" || typeof body !== "string" || typeof url !== "string" || typeof publishedAt !== "string") {
        return undefined;
    }
    if (release.draft === true || release.prerelease === true) {
        return undefined;
    }
    const notes = parseNotes(body);
    const breaking = parseBreaking(body);
    // A release with no user-facing or breaking notes is not an entry; a release that only breaks still is.
    return notes.length === 0 && breaking.length === 0 ? undefined : { version: tag.replace(/^v/, ""), publishedAt, url, notes, breaking };
};

export interface Changelog {
    entries: ChangelogEntry[];
    /** True when the read failed, so the page can say the list is incomplete rather than imply it is empty. */
    unavailable: boolean;
}

export const loadChangelog = async (): Promise<Changelog> => {
    try {
        // Used when CI provides one, for a higher rate limit; the repo is public, so it's optional locally.
        const token = process.env.GITHUB_TOKEN;
        const response = await fetch(RELEASES_API, {
            headers: {
                accept: "application/vnd.github+json",
                ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }),
            },
        });
        if (!response.ok) {
            throw new Error(`releases ${response.status}`);
        }
        const releases = (await response.json()) as GithubRelease[];
        const entries = releases.map(toEntry).filter((entry) => entry !== undefined);
        // Newest first. GitHub already answers in that order; sorting makes it true rather than assumed.
        entries.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
        return { entries, unavailable: false };
    } catch (error) {
        console.warn(`[changelog] live read failed (${String(error)}): the page will point at ${githubReleasesUrl}`);
        return { entries: [], unavailable: true };
    }
};
