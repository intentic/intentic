import { STATE_DIR } from "@intentic/sandbox-contract";
/* WHERE THE DOCUMENTS LIVE — two trees, and the reason there are two.
 *
 * PUBLISHED: a package's page is its own `README.md`, beside its code; only the repo-level map lives apart, at
 * `<repo>/docs/architecture/`. In the repo, in git, landed and reviewed like code, and present for anyone who
 * clones it. Documentation is an asset ABOUT the code, so it has to travel with the code and be reviewable in
 * the same diff as the change that invalidated it. That is the whole reason it does not live in `.intentic/` the
 * way an acceptance run's reports do: a run is point-in-time evidence, a document is a maintained artifact.
 *
 * Putting the package page IN the package is the strongest form of the same argument. A parallel tree is a
 * second place to remember, and the one nobody has open while editing — the layout it replaced reached 61 stale
 * pages out of 69, one of them 203 commits behind. A README cannot be forgotten in the same way: it is in the
 * diff already.
 *
 * STAGING: `.intentic/config/docs/<repo>/`, mirroring the published tail exactly. Generation writes here first, for
 * three reasons that all matter:
 *   1. N isolated agents can write into it at once — `.intentic` is bound back SHARED for isolated turns, so
 *      every agent in a fan-out lands in the same tree the browser is reading.
 *   2. The browser sees it appear LIVE. `.intentic/config/docs/` is a workspace-root path, so it can ride the daemon's
 *      file-change push (contributes.files) — an in-repo path cannot, because a manifest is static and repo
 *      names are not known when it is written.
 *   3. The owner reads it before it touches the repo. "Agent proposes, owner approves, it publishes" is already
 *      this workspace's shape for agent output (`.intentic/config/drafts/`), not a new idea.
 *
 * The two trees share their TAIL (`repo.json`, `<pkg>/README.md`, …) so publishing is a copy per tail and never a
 * translation — and so a reviewer reading either tree is reading the same layout. */

// Repo-relative. Sits beside `docs/user-stories` (what the product promises) as its structural sibling: what
// the code IS. A plain directory name, because the documents themselves are the evidence the view detects on.
export const DOCS_DIR = "docs/architecture";

// Workspace-root-relative. One prefix for everything this extension stages, which is what makes a single
// `contributes.files` entry able to cover it.
export const STAGING_ROOT = `${STATE_DIR}/config/docs`;

/* The tails a document set is made of. The repo-level three are written once per repo; a package page is written
 * once per package, under the package's own dir.
 *
 * There is NO per-package JSON sidecar. Everything one would have carried is derived by `intentic-docs` from the
 * README and from git: the one-liner is its lead sentence, the anchors are its `## Key files` links, and how far
 * the code has run ahead of it is a commit count. A field an author must remember to update is a field that goes
 * wrong; a field computed from what they did update cannot.
 *
 * `index.json` is DERIVED — `intentic-docs check` regenerates it, and nothing authors it by hand. It exists so
 * the browser can render the package list, its one-liners, its anchors and its staleness in ONE fetch instead of
 * one per package. A generated file cannot drift from its own inputs. */
export const REPO_DOC_TAIL = "repo.json";
export const REPO_PROSE_TAIL = "repo.md";
export const INDEX_TAIL = "index.json";
export const README_TAIL = "README.md";
export const packagePageTail = (dir: string): string => `${dir}/${README_TAIL}`;

// The three the map is made of. Everything else in a set is a package page, and that is the whole distinction
// publishing needs: a map tail lands under `docs/architecture/`, a page tail lands on the package itself.
const MAP_TAILS: ReadonlySet<string> = new Set([REPO_DOC_TAIL, REPO_PROSE_TAIL, INDEX_TAIL]);

/* A tail → where it lives inside the repository. This is the ONE place the two-destination layout is expressed;
 * publishing is still a copy per tail, it just has two possible parents instead of one. */
export const publishedTail = (tail: string): string => (MAP_TAILS.has(tail) ? `${DOCS_DIR}/${tail}` : tail);

/* WHETHER A LISTING OF A REPO'S STAGING DIRECTORY IS A DRAFT. Everything counts EXCEPT `index.json`, and that one
 * exception is the whole reason this is a rule rather than "the directory is not empty".
 *
 * The index is derived, as the paragraph above says: `intentic-docs check --write` regenerates it for whichever
 * tree it is pointed at, and its default is the staged one — so an agent updating a README that is already in the
 * repository drops an index into a staging directory that holds no draft. Counting it emptied the whole area: the
 * view switched to a draft with no map and no pages, said the repository had no documentation yet, and left the
 * real published documents behind a toggle nobody had a reason to press.
 *
 * A HALF-WRITTEN DRAFT MUST STILL COUNT — a run in flight is exactly what the draft banner exists to explain —
 * and it does: the map's `repo.json` and each package's directory are entries like any other. */
export const holdsDraft = (names: readonly string[]): boolean => names.some((name) => name !== INDEX_TAIL);

// A repo-relative path → workspace-root-relative. The workspace's own root repo is the empty string (the daemon
// calls it "root" in git routes), and joining "" would produce a leading slash.
export const underRepo = (repo: string, rest: string): string => (repo === `` ? rest : `${repo}/${rest}`);

/* The inverse, against the repos the workspace actually has: a workspace path → which repo it is in and where
 * inside it. LONGEST match wins, because the root repo ("") contains every path and would otherwise swallow a
 * nested repo's packages — and a repo dir itself answers with an empty rest, which is the repository's own
 * overview page rather than any package's.
 *
 * This is what lets a document be addressed by the path the file tree already speaks, so nothing has to carry a
 * (repo, dir) pair around: the workspace path IS the identity, and it survives being written into a stored tab. */
export const splitRepo = (path: string, repos: readonly string[]): { repo: string; dir: string } | undefined => {
    const owner = repos
        .filter((repo) => repo === `` || repo === path || path.startsWith(`${repo}/`))
        .toSorted((left, right) => right.length - left.length)[0];
    if (owner === undefined) {
        return undefined;
    }
    return { repo: owner, dir: owner === `` ? path : path.slice(owner.length + 1) };
};

export const publishedPath = (repo: string, tail: string): string => underRepo(repo, publishedTail(tail));

// The staging key for a repo. The root repo needs a NAME here — it is a directory under STAGING_ROOT, and an
// empty segment would collapse the path onto the root itself.
export const stagingKey = (repo: string): string => (repo === `` ? `root` : repo);
export const stagingDir = (repo: string): string => `${STAGING_ROOT}/${stagingKey(repo)}`;
export const stagingPath = (repo: string, tail: string): string => `${stagingDir(repo)}/${tail}`;

// ---- runs ---------------------------------------------------------------------------------------------------

/* A generation run's own directory, beside the staged documents rather than inside any repo: it is bookkeeping
 * about agents, not documentation, and it must never be publishable. */
export const RUNS_DIR = `${STAGING_ROOT}/runs`;
const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
export const runManifestPath = (runId: string): string => `${runDir(runId)}/run.json`;

// What the rail badge has already been shown, in the same tree as the runs it summarises — so acknowledging is
// durable across reloads and shared across the owner's browsers without inventing a setting nobody would type.
export const SEEN_PATH = `${STAGING_ROOT}/seen.json`;

// How many runs deep anything that reads run state goes. Only the newest runs carry news, and a workspace with
// a long history must not spend a request per run to light a badge.
export const SCAN_RUNS = 10;

/* `r` + a base-36 timestamp: sortable, short, and readable enough to match a directory to a moment. Taken from
 * the caller so this module stays pure and testable. */
export const runIdAt = (epochMs: number): string => `r${epochMs.toString(36)}`;

/* A package directory → a slug usable in a conversation id AND a run subdirectory. `_deploy/graph` must not
 * become two path segments, so separators collapse to dashes; anything outside the id charset goes too, and a
 * dir that reduces to nothing (a non-Latin name) falls back to `pkg` with the caller's uniqueness suffix still
 * doing its work. */
export const slugOf = (dir: string): string => {
    const reduced = dir
        .toLowerCase()
        .replace(/[/\\]+/g, `-`)
        .replace(/[^a-z0-9-]+/g, `-`)
        .replace(/-+/g, `-`)
        .replace(/^-|-$/g, ``);
    return reduced === `` ? `pkg` : reduced.slice(0, 40);
};

// The conversationId regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` (it lands in branch names and paths), so 64 is
// a hard ceiling. The RUN id is what must survive truncation — it attributes a fleet card back to its run — so
// the slug is what gets cut, and slugs are already capped at 40 with run ids around 9.
const CONVERSATION_ID_MAX = 64;

// `dg` for "docs generation" — the prefix `GET /agents` is filtered by to join a run to the live fleet, which is
// why the ids are derived rather than stored.
/* Exported because THREE things filter on it — one run's agents, any run's agents, and the poll deciding whether
 * to keep polling — and the id scheme has to live in one place. */
const RUN_ID_PREFIX = "dg";

// Every documentation-run conversation, across all runs.
export const ANY_RUN_PREFIX = `${RUN_ID_PREFIX}-`;

export const conversationIdOf = (runId: string, slug: string): string =>
    `${RUN_ID_PREFIX}-${runId}-${slug}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/, ``);

// The map phase's own conversation — one per run, before the fan-out. Named so it sorts first and reads as what
// it is in the fleet board.
export const mapConversationId = (runId: string): string => conversationIdOf(runId, `map`);

/* Every conversation belonging to a run starts with this. A run whose scope the MAP decides cannot enumerate its
 * own conversation ids, so joining it to the live fleet is a prefix filter over `GET /agents` — which is the whole
 * reason the ids are derived from the run id instead of being stored anywhere. */
export const runPrefix = (runId: string): string => `${ANY_RUN_PREFIX}${runId}-`;
