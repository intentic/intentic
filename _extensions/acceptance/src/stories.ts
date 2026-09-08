import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";

// A repo's user stories, read from docs/user-stories: one file is one story, one session, one report, never split by
// section, since a walkthrough's setup and state live in the whole file. Subdirectories are groups, shown one level
// deep by first path segment. Stories stay markdown files in the repo, beside the code and in the diff that changes it.

export const STORIES_DIR = "docs/user-stories";

// Lets a repo tune the brief without forking the extension; dot-prefixed so it never reads as a story.
export const BRIEF_OVERRIDE = `${STORIES_DIR}/.acceptance.md`;

// Markdown is the norm; .feature and .txt are accepted too, since the brief hands the text to a model verbatim and
// never parses it.
const STORY_EXTENSIONS = [".md", ".markdown", ".feature", ".txt"];

export interface Story {
    // Which repo this story belongs to; see `group` for which app within it.
    readonly repo: string;
    // Root-relative path, what /workspace/file is asked for.
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

// A conversation id is `xt-<runId>-<slug>` against a strict pattern, and the slug also becomes a directory name, so
// it's reduced to lowercase alphanumerics and dashes rather than trusted; nothing Latin in the name falls back to
// `story`.
export const slugOf = (path: string): string => {
    const base = withoutExtension(path.split(`/`).pop() ?? path);
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 40);
    return slug === `` ? `story` : slug;
};

// How far into a file to look for its title heading; further down is a section, not the document's name.
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

// An app's address is a property of the group, not the repo, since one repo can serve several apps on different ports;
// an ungrouped story simply targets its repo. Key is `<repo>/<group>`, matching the directory it names.
export const targetKeyOf = (story: Pick<Story, "repo" | "group">): string => (story.group === `` ? story.repo : `${story.repo}/${story.group}`);

// Folds a workspace listing (already flattened by the caller) into stories; pure, so it's testable without a daemon.
// Slugs are uniqued with `-2`, `-3`, within one repo; uniqueOf below settles cross-repo collisions.
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
                repo,
                path,
                slug: seen === 0 ? base : `${base}-${seen + 1}`,
                title: titleOf(path, titles[path]),
                group: segments.length > 1 ? (segments[0] ?? ``) : ``,
            };
        });
};

// Renumbers a slug two repos both produced, since site/checkout.md and api/checkout.md would otherwise derive the same
// conversation id and run directory, the same failure storiesOf already prevents within one repo.
export const uniqueOf = (stories: readonly Story[]): Story[] => {
    const taken = new Map<string, number>();
    return stories.map((story) => {
        const seen = taken.get(story.slug) ?? 0;
        taken.set(story.slug, seen + 1);
        return seen === 0 ? story : { ...story, slug: `${story.slug}-${seen + 1}` };
    });
};

// Criteria are a checklist section of the story file, not a sidecar, so a PR reviewing the file sees them and the brief
// can inline the whole thing. Authoring them structurally is what lets the agent return one verdict per criterion, in
// order; a story with none still works, falling back to reading criteria out of the prose.

const CRITERIA_HEADING = "## Acceptance criteria";
// Matches `- [ ] text`, `- [x] text` or a bare `- text`; the box state carries no meaning, since a criterion is
// verified by a run, never by ticking it in an editor.
const CRITERION_LINE = /^\s*[-*]\s+(?:\[[ xX]?\]\s*)?(.+?)\s*$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

const headingIndex = (lines: readonly string[]): number => lines.findIndex((line) => line.trim().toLowerCase() === CRITERIA_HEADING.toLowerCase());

export const criteriaOf = (content: string | undefined): string[] => {
    const lines = (content ?? ``).split(`\n`);
    const start = headingIndex(lines);
    if (start === -1) {
        return [];
    }
    const rest = lines.slice(start + 1);
    // Stops at the next heading of any level, so a criteria list isn't eaten by a later `## Notes`.
    const end = rest.findIndex((line) => HEADING_LINE.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).flatMap((line) => {
        const match = CRITERION_LINE.exec(line);
        return match?.[1] === undefined || match[1] === `` ? [] : [match[1]];
    });
};

// The file a new story starts as: the typed title, and an empty Acceptance criteria section to type into. The former
// assemble-from-parts editor is gone (StoryRow edits the raw file); this keeps only what was always also minting a
// file.
export const newStoryMarkdown = (title: string): string => `# ${title.trim()}\n\n${CRITERIA_HEADING}\n\n- \n`;

// Where a newly authored story lands: the slug becomes the filename, the group its subdirectory ("" for the top level).
export const storyPath = (repo: string, group: string, slug: string): string => `${repo}/${STORIES_DIR}/${group === `` ? `` : `${group}/`}${slug}.md`;
