import { STATE_DIR } from "@intentic/sandbox-contract";
import { type BatchRunKind, batchConversationId, batchRunIdAt, batchRunManifestPath, batchRunPrefix, batchRunsDir } from "@intentic/sandbox-contract/batch-runs";
// Two trees: PUBLISHED (a package's own README, the map under `docs/architecture/`) travels with the code and reviews
// in the same diff. STAGING (`.intentic/config/docs/<repo>/`) mirrors it tail-for-tail so generation can write
// concurrently, push live to the browser, and wait for owner review before publishing.

// Repo-relative; sibling to `docs/user-stories`, what the code is rather than what it promises.
export const DOCS_DIR = "docs/architecture";

// Workspace-root-relative; one prefix for everything staged, so a single `contributes.files` entry covers it.
export const STAGING_ROOT = `${STATE_DIR}/config/docs`;

// No per-package sidecar: derived from the README and git; `index.json` is regenerated, never hand-authored.
export const REPO_DOC_TAIL = "repo.json";
export const REPO_PROSE_TAIL = "repo.md";
export const INDEX_TAIL = "index.json";
export const README_TAIL = "README.md";
export const packagePageTail = (dir: string): string => `${dir}/${README_TAIL}`;

// The map's three tails; everything else is a package page, which decides where publishing lands.
const MAP_TAILS: ReadonlySet<string> = new Set([REPO_DOC_TAIL, REPO_PROSE_TAIL, INDEX_TAIL]);

// Tail to where it lives in the repository; the one place the two-destination layout is expressed.
export const publishedTail = (tail: string): string => (MAP_TAILS.has(tail) ? `${DOCS_DIR}/${tail}` : tail);

// Everything except `index.json` counts as draft content, since the index alone can appear from an ordinary `check
// --write` with no map or pages.
export const holdsDraft = (names: readonly string[]): boolean => names.some((name) => name !== INDEX_TAIL);

// Repo-relative to workspace-root-relative; the root repo is "", so a naive join would produce a leading slash.
export const underRepo = (repo: string, rest: string): string => (repo === `` ? rest : `${repo}/${rest}`);

// Workspace path to (repo, dir); longest match wins, since the root repo ("") contains every path and would otherwise
// swallow a nested repo's packages.
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

// Root repo needs a name here (a directory under STAGING_ROOT); an empty segment would collapse onto the root itself.
export const stagingKey = (repo: string): string => (repo === `` ? `root` : repo);
export const stagingDir = (repo: string): string => `${STAGING_ROOT}/${stagingKey(repo)}`;
export const stagingPath = (repo: string, tail: string): string => `${stagingDir(repo)}/${tail}`;

// Runs.

// Run bookkeeping beside the staged documents, never publishable; shares the core batch-run substrate.
const KIND: BatchRunKind = {
    runsDir: `config/docs/runs`,
    // `dg` for docs generation; the prefix `GET /agents` filters by, joining a run to the live fleet.
    prefix: `dg`,
    // How many recent runs are scanned; older ones carry no news and shouldn't cost a request each.
    scanRuns: 10,
};

export const RUNS_DIR = batchRunsDir(KIND);
export const runManifestPath = (runId: string): string => batchRunManifestPath(KIND, runId);

// What the rail badge has shown, in the same tree as the runs it summarizes; durable across reloads.
export const SEEN_PATH = `${STAGING_ROOT}/seen.json`;

export const SCAN_RUNS = KIND.scanRuns;

export const runIdAt = (epochMs: number): string => batchRunIdAt(epochMs);

// Package dir to a slug for a conversation id and run subdirectory; separators and non-id characters collapse to
// dashes, and a dir that reduces to nothing falls back to `pkg`.
export const slugOf = (dir: string): string => {
    const reduced = dir
        .toLowerCase()
        .replace(/[/\\]+/g, `-`)
        .replace(/[^a-z0-9-]+/g, `-`)
        .replace(/-+/g, `-`)
        .replace(/^-|-$/g, ``);
    return reduced === `` ? `pkg` : reduced.slice(0, 40);
};

// Every doc-run conversation, across all runs; exported since three different filters key off this same prefix.
export const ANY_RUN_PREFIX = batchRunPrefix(KIND);

// Overflow past 64 characters trims the slug, not the run id, since the run id is what attributes a fleet card back to
// its run.
export const conversationIdOf = (runId: string, slug: string): string => batchConversationId(KIND, runId, slug);

// The map phase's own conversation, named to sort first and read as what it is on the fleet board.
export const mapConversationId = (runId: string): string => conversationIdOf(runId, `map`);

// Every conversation in a run starts with this; since the map decides scope, joining a run to the fleet is a prefix
// filter over `GET /agents`, not a stored list.
export const runPrefix = (runId: string): string => `${ANY_RUN_PREFIX}${runId}-`;
