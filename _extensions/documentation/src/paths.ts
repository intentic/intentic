/* WHERE THE DOCUMENTS LIVE — two trees, and the reason there are two.
 *
 * PUBLISHED: `<repo>/docs/architecture/`. In the repo, in git, landed and reviewed like code, and present for
 * anyone who clones it. Documentation is an asset ABOUT the code, so it has to travel with the code and be
 * reviewable in the same diff as the change that invalidated it. That is the whole reason it does not live in
 * `.intentic/` the way an acceptance run's reports do: a run is point-in-time evidence, a document is a
 * maintained artifact.
 *
 * STAGING: `.intentic/docs/<repo>/`, mirroring the published tail exactly. Generation writes here first, for
 * three reasons that all matter:
 *   1. N isolated agents can write into it at once — `.intentic` is bound back SHARED for isolated turns, so
 *      every agent in a fan-out lands in the same tree the browser is reading.
 *   2. The browser sees it appear LIVE. `.intentic/docs/` is a workspace-root path, so it can ride the daemon's
 *      file-change push (contributes.files) — an in-repo path cannot, because a manifest is static and repo
 *      names are not known when it is written.
 *   3. The owner reads it before it touches the repo. "Agent proposes, owner approves, it publishes" is already
 *      this workspace's shape for agent output (`.intentic/drafts/`), not a new idea.
 *
 * The two trees share their TAIL (`repo.json`, `<pkg>/doc.md`, …) so publishing is a copy per tail and never a
 * translation — and so a reviewer reading either tree is reading the same layout. */

// Repo-relative. Sits beside `docs/user-stories` (what the product promises) as its structural sibling: what
// the code IS. A plain directory name, because the documents themselves are the evidence the view detects on.
export const DOCS_DIR = "docs/architecture";

// Workspace-root-relative. One prefix for everything this extension stages, which is what makes a single
// `contributes.files` entry able to cover it.
export const STAGING_ROOT = ".intentic/docs";

/* The tails a document set is made of. The repo-level three are written once per repo; `doc.json`/`doc.md` are
 * written once per package, under the package's own dir.
 *
 * `index.json` is DERIVED — `intentic-docs check` regenerates it from the authored files, and nothing authors it
 * by hand. It exists so the browser can render the package list, its one-liners and its staleness in ONE fetch
 * instead of one per package; putting those one-liners in repo.json instead would duplicate a fact that doc.json
 * already owns and let the two drift. A generated file cannot drift from its own inputs. */
export const REPO_DOC_TAIL = "repo.json";
export const REPO_PROSE_TAIL = "repo.md";
export const INDEX_TAIL = "index.json";
export const packageDocTail = (dir: string): string => `${dir}/doc.json`;
export const packageProseTail = (dir: string): string => `${dir}/doc.md`;

// A repo-relative path → workspace-root-relative. The workspace's own root repo is the empty string (the daemon
// calls it "root" in git routes), and joining "" would produce a leading slash.
const underRepo = (repo: string, rest: string): string => (repo === `` ? rest : `${repo}/${rest}`);

export const publishedDir = (repo: string): string => underRepo(repo, DOCS_DIR);
export const publishedPath = (repo: string, tail: string): string => `${publishedDir(repo)}/${tail}`;

// The staging key for a repo. The root repo needs a NAME here — it is a directory under STAGING_ROOT, and an
// empty segment would collapse the path onto the root itself.
export const stagingKey = (repo: string): string => (repo === `` ? `root` : repo);
export const stagingDir = (repo: string): string => `${STAGING_ROOT}/${stagingKey(repo)}`;
export const stagingPath = (repo: string, tail: string): string => `${stagingDir(repo)}/${tail}`;

// ---- runs ---------------------------------------------------------------------------------------------------

/* A generation run's own directory, beside the staged documents rather than inside any repo: it is bookkeeping
 * about agents, not documentation, and it must never be publishable. */
export const RUNS_DIR = `${STAGING_ROOT}/runs`;
export const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
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

/* A package directory → a slug usable in a conversation id AND a run subdirectory. `_libs/graph` must not
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
export const conversationIdOf = (runId: string, slug: string): string =>
    `dg-${runId}-${slug}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/, ``);

// The map phase's own conversation — one per run, before the fan-out. Named so it sorts first and reads as what
// it is in the fleet board.
export const mapConversationId = (runId: string): string => conversationIdOf(runId, `map`);

/* Every conversation belonging to a run starts with this. A run whose scope the MAP decides cannot enumerate its
 * own conversation ids, so joining it to the live fleet is a prefix filter over `GET /agents` — which is the whole
 * reason the ids are derived from the run id instead of being stored anywhere. */
export const runPrefix = (runId: string): string => `dg-${runId}-`;
