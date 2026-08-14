import { githubReleasesUrl } from "@intentic-dev/site-content/site";

/* THE CHANGELOG'S DATA, read at BUILD time from the published GitHub Releases: the same bargain the extension
 * gallery makes next door (registry.ts): a static page cut from somebody else's JSON, with no backend behind it.
 *
 * THE RELEASE BODY IS THE SOURCE, and that is the whole design rather than an implementation detail. Notes are
 * written into commits as `Release-Note:` trailers, harvested into the Release at publish time
 * (_tools/scripts/publish-github.sh) and read back here. Nothing is reviewed before it goes out, so the one
 * property that has to hold is that a bad line can be FIXED in a single place afterwards: editing the Release
 * body on GitHub corrects this page on the next build and the sandbox's update card immediately, because both
 * quote the same text. A copy vendored into this repo would have been a second place to fix, and the one
 * everybody forgets.
 *
 * NO FALLBACK COPY, unlike the gallery. A gallery a fortnight stale is still a gallery; a changelog a fortnight
 * stale is wrong in the one way a changelog must not be. When the read fails the page says so and points at the
 * releases page, which is honest and still builds: a marketing site must not go red because api.github.com had
 * a bad minute. */

const RELEASES_API = "https://api.github.com/repos/intentic/intentic/releases?per_page=100";

// The headings publish-github.sh writes, and the contract between the two files. Everything under each, up to
// the next heading, is the release's user-facing notes, and its breaking sentences, when a commit declared a
// break (`Breaking-Note:` trailers, the rare sibling of `Release-Note:`).
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
    /** The user-facing lines, in the order the release lists them. Never empty: see loadChangelog. */
    notes: string[];
    /** What this release takes away: the "Breaking changes" lines. Empty for almost every release. */
    breaking: string[];
}

/* The bullets under "What's new", or none. Written against the shape publish-github.sh emits rather than as a
 * general markdown parser: a release body is a document this repo writes, so the only two things worth handling
 * are the heading and the `- ` lines beneath it. A body with no such section (every release before this feature,
 * and every release since whose commits all turned out to be invisible to users) yields nothing, which is what
 * keeps it off the page entirely. */
const sectionBullets = (body: string, heading: RegExp): string[] => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const notes: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        // The next heading of any level ends the section: "### Features" is where the commit-subject list starts.
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
    // A release nobody outside the project would notice is not an entry. At three releases a day this is most of
    // them. Listing them as "1.184.1: nothing to report" is the noise the notes exist to replace. A
    // release that only breaks is still an entry: that is the one page must not go quiet about.
    return notes.length === 0 && breaking.length === 0 ? undefined : { version: tag.replace(/^v/, ""), publishedAt, url, notes, breaking };
};

export interface Changelog {
    entries: ChangelogEntry[];
    /** True when the read failed, so the page can say the list is incomplete rather than imply it is empty. */
    unavailable: boolean;
}

export const loadChangelog = async (): Promise<Changelog> => {
    try {
        // The token is used when CI happens to have one (a higher rate limit); the repository is public, so the
        // build works perfectly well without one and a local `pnpm build` needs no setup.
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
