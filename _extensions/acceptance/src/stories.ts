import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";

/* A repo's user stories, read off `docs/user-stories`. One FILE is one story — one test session, one agent, one
 * report. Not a section-level split: an acceptance run is a walkthrough with setup and state, and cutting a
 * file into fragments would hand each agent a scenario whose preconditions live in a sibling fragment. A repo
 * that wants finer tests writes finer files.
 *
 * Subdirectories are groups, not stories, and they nest one level in the UI (`auth/01-sign-in.md` shows under
 * "auth") — deeper trees still work, the group is just the first segment.
 *
 * Stories stay MARKDOWN FILES IN THE REPO even though the view that edits them is workspace-wide. A story is
 * product documentation: it belongs beside the code that implements it, in the diff that changes it, and in the
 * worktree an agent tests from. The editor writes this format; nothing about the format requires the editor. */

export const STORIES_DIR = "docs/user-stories";

// A repo may tune the brief without forking the extension — see brief.ts. Lives beside the stories, dot-prefixed
// so it never reads as one.
export const BRIEF_OVERRIDE = `${STORIES_DIR}/.acceptance.md`;

// What counts as a story file. Markdown is the norm; .feature (Gherkin) and .txt are accepted because the brief
// hands the text to a model verbatim — it never parses the story, so the format is the author's business.
const STORY_EXTENSIONS = [".md", ".markdown", ".feature", ".txt"];

export interface Story {
    // The repo this story belongs to — which app it is walked through, and how the view groups it.
    readonly repo: string;
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

/* WHERE A STORY'S APP ANSWERS is a property of its GROUP, not of its repo. One repository can serve several
 * applications — a monorepo's marketing site and its web app are two dev servers on two ports — and the group is
 * the only thing in a stories tree that already says which is which. So a run resolves one address per
 * (repo, group) pair, and an ungrouped story simply targets its repo, which is what every run did before groups
 * could be aimed. The key is `<repo>/<group>` so it reads as the directory it names. */
export const targetKeyOf = (story: Pick<Story, "repo" | "group">): string => (story.group === `` ? story.repo : `${story.repo}/${story.group}`);

/* Fold a listing into stories. `entries` is what /workspace/children returned for `docs/user-stories` and each
 * of its subdirectories, flattened by the caller — this stays pure so it is testable without a daemon.
 *
 * Slugs are made unique by suffixing `-2`, `-3`, … because two groups may legitimately hold `overview.md`, and a
 * collision would otherwise put two agents in one run directory, silently overwriting each other's report. This
 * pass only sees ONE repo; uniqueOf() below settles the collisions only a cross-repo merge can produce. */
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

/* Merge several repos' stories into the one list the workspace-wide view shows, renumbering any slug two REPOS
 * both produced. Without this, `site/docs/user-stories/checkout.md` and `api/docs/user-stories/checkout.md`
 * derive the same conversation id and the same run directory — two agents overwriting each other's report, which
 * is the exact failure storiesOf() already prevents inside one repo. */
export const uniqueOf = (stories: readonly Story[]): Story[] => {
    const taken = new Map<string, number>();
    return stories.map((story) => {
        const seen = taken.get(story.slug) ?? 0;
        taken.set(story.slug, seen + 1);
        return seen === 0 ? story : { ...story, slug: `${story.slug}-${seen + 1}` };
    });
};

/* ---- The acceptance criteria a story declares -------------------------------------------------------------
 *
 * Criteria are a CHECKLIST SECTION of the story file, not a sidecar: the file stays the one thing a human reads
 * and a PR reviews, and the brief inlines it whole either way. Authoring them structurally is what buys the
 * report its matrix — the agent is told to return one verdict per authored criterion, in order, so a run's
 * findings line up with what someone actually promised rather than with the agent's paraphrase of the prose.
 *
 * A story with no such section is still a story. The brief falls back to "read the criteria out of the text
 * yourself", which is what every story did before the section existed. */

const CRITERIA_HEADING = "## Acceptance criteria";
// `- [ ] text`, `- [x] text`, or a plain `- text` — authors write all three, and the box state carries no meaning
// here: a criterion is verified by a run, never by someone ticking it in an editor.
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
    // The section runs to the next heading of ANY level — a criteria list followed by "## Notes" must not eat it.
    const end = rest.findIndex((line) => HEADING_LINE.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).flatMap((line) => {
        const match = CRITERION_LINE.exec(line);
        return match?.[1] === undefined || match[1] === `` ? [] : [match[1]];
    });
};

// Everything that is neither the title line nor the criteria section — what the editor shows in its prose box.
export const narrativeOf = (content: string | undefined): string => {
    const lines = (content ?? ``).split(`\n`);
    const start = headingIndex(lines);
    const body = start === -1 ? lines : lines.slice(0, start);
    // Drop a leading `# Title`: the editor owns that as its own field, and keeping it here would duplicate the
    // heading on the next save.
    const withoutHeading = body[0] !== undefined && /^#\s+/.test(body[0]) ? body.slice(1) : body;
    return withoutHeading.join(`\n`).trim();
};

// The file the editor writes. Deliberately the plainest markdown that round-trips through the parsers above, so
// a story hand-written in an editor and a story written here are the same artifact.
export const storyMarkdown = (input: { readonly title: string; readonly narrative: string; readonly criteria: readonly string[] }): string => {
    const narrative = input.narrative.trim();
    const criteria = input.criteria.map((text) => text.trim()).filter((text) => text !== ``);
    const sections = [`# ${input.title.trim()}`, ...(narrative === `` ? [] : [narrative])];
    if (criteria.length > 0) {
        sections.push([CRITERIA_HEADING, ``, ...criteria.map((text) => `- [ ] ${text}`)].join(`\n`));
    }
    return `${sections.join(`\n\n`)}\n`;
};

// Where a newly authored story lands. The slug is the filename, so the title someone typed is what they later
// find in the tree; the group is the subdirectory it lands in, `""` for the top level.
export const storyPath = (repo: string, group: string, slug: string): string => `${repo}/${STORIES_DIR}/${group === `` ? `` : `${group}/`}${slug}.md`;
