import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";

/* A repo's user stories, read off `docs/user-stories`. One FILE is one story — one test session, one agent, one
 * report. Not a section-level split: an exploratory test is a walkthrough with setup and state, and cutting a
 * file into fragments would hand each agent a scenario whose preconditions live in a sibling fragment. A repo
 * that wants finer tests writes finer files.
 *
 * Subdirectories are groups, not stories, and they nest one level in the UI (`auth/01-sign-in.md` shows under
 * "auth") — deeper trees still work, the group is just the first segment. */

export const STORIES_DIR = "docs/user-stories";

// A repo may tune the brief without forking the extension — see brief.ts. Lives beside the stories, dot-prefixed
// so it never reads as one.
export const BRIEF_OVERRIDE = `${STORIES_DIR}/.exploratory.md`;

// What counts as a story file. Markdown is the norm; .feature (Gherkin) and .txt are accepted because the brief
// hands the text to a model verbatim — it never parses the story, so the format is the author's business.
const STORY_EXTENSIONS = [".md", ".markdown", ".feature", ".txt"];

export interface Story {
    // Root-relative path — what /workspace/file is asked for.
    readonly path: string;
    // Stable, filesystem-free identity used in the run directory and the conversation id.
    readonly slug: string;
    // Display name: the file's first heading, else its de-slugged filename.
    readonly title: string;
    // The first path segment under docs/user-stories when the story sits in a subdirectory; "" at the top level.
    readonly group: string;
}

const isStoryFile = (entry: WorkspaceTreeEntry): boolean =>
    entry.type === `file` && !entry.name.startsWith(`.`) && STORY_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension));

const withoutExtension = (name: string): string => name.replace(/\.[^.]+$/, ``);

/* A conversation id is `xt-<runId>-<slug>` against `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`, and the slug is also a
 * directory name, so it is reduced to lowercase alphanumerics and dashes here rather than trusted. A file named
 * only in non-Latin script would reduce to nothing, so an empty result falls back to `story` and the caller's
 * uniqueness pass numbers the collisions. */
export const slugOf = (path: string): string => {
    const base = withoutExtension(path.split(`/`).pop() ?? path);
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 40);
    return slug === `` ? `story` : slug;
};

// The leading `# Heading` of a story file, ignoring front matter and Gherkin's `Feature:` prefix. Bounded to the
// first handful of lines: a heading further down is a section, not the document's name.
const HEADING_SCAN_LINES = 20;

export const titleOf = (path: string, content: string | undefined): string => {
    for (const line of (content ?? ``).split(`\n`).slice(0, HEADING_SCAN_LINES)) {
        const heading = /^#\s+(.+?)\s*$/.exec(line) ?? /^\s*Feature:\s*(.+?)\s*$/.exec(line);
        if (heading?.[1] !== undefined && heading[1] !== ``) {
            return heading[1];
        }
    }
    // `03-reset-password.md` → "Reset password": drop an ordering prefix, then de-slug.
    const words = withoutExtension(path.split(`/`).pop() ?? path)
        .replace(/^\d+[-_.]?\s*/, ``)
        .replace(/[-_]+/g, ` `)
        .trim();
    const name = words === `` ? withoutExtension(path.split(`/`).pop() ?? path) : words;
    return name.charAt(0).toUpperCase() + name.slice(1);
};

/* Fold a listing into stories. `entries` is what /workspace/children returned for `docs/user-stories` and each
 * of its subdirectories, flattened by the caller — this stays pure so it is testable without a daemon.
 *
 * Slugs are made unique by suffixing `-2`, `-3`, … because two groups may legitimately hold `overview.md`, and a
 * collision would otherwise put two agents in one run directory, silently overwriting each other's report. */
export const storiesOf = (repo: string, entries: readonly WorkspaceTreeEntry[], titles: Readonly<Record<string, string>> = {}): Story[] => {
    const prefix = `${repo}/${STORIES_DIR}/`;
    const taken = new Map<string, number>();
    return entries
        .filter(isStoryFile)
        .map((entry) => entry.path)
        .toSorted((left, right) => left.localeCompare(right))
        .map((path) => {
            const base = slugOf(path);
            const seen = taken.get(base) ?? 0;
            taken.set(base, seen + 1);
            const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
            const segments = relative.split(`/`);
            return {
                path,
                slug: seen === 0 ? base : `${base}-${seen + 1}`,
                title: titleOf(path, titles[path]),
                group: segments.length > 1 ? (segments[0] ?? ``) : ``,
            };
        });
};
