import { STATE_DIR } from "@intentic/constants";
import { RETIRED_WORKSPACE_STATE_DIRS } from "@intentic/sandbox-contract";

// Where the index lives, root-relative. Excluded from every view so the index can never surface itself.
export const IQ_DIR = `${STATE_DIR}/cache/iq`;

/* The agent plane's own byproducts, root-relative — never the code a search is about.
 *
 * The index (self-exclusion: it must not surface itself), provider runtime homes, session transcripts, durable
 * artifacts, connector runtime, and Chromium login profiles. Transcript mining showed conversation JSONL
 * outranking source in refs and ask results — an agent's own past conversations answering a question about the
 * codebase. Excluding auth is also a safety boundary for the index: no token should be copied into search text.
 *
 * Deliberately NOT the whole `.intentic/` dir: its manifests (settings.json, capabilities.json, the
 * environment Dockerfiles, automations, approvals, drafts) are things a user writes and an agent is regularly
 * asked to find and edit. Excluding those would trade one silent blind spot for another. */
const retiredDirs = Object.values(RETIRED_WORKSPACE_STATE_DIRS).flatMap((dirs) => dirs.map((dir) => `.intentic/${dir}`));
const DENIED_DIRS = [
    IQ_DIR,
    `${STATE_DIR}/auth`,
    `${STATE_DIR}/sessions`,
    `${STATE_DIR}/artifacts`,
    `${STATE_DIR}/runtime`,
    `${STATE_DIR}/browser`,
    ...retiredDirs,
];

// The engine's always-on floor — every engine (sweep, ripgrep, git, cursor replay) filters emitted paths
// through it, and `--ignored` never lifts it.
//
// Matched at ANY depth, not just the workspace root: a workspace can contain checkouts that are themselves
// intentic workspaces, and the root-only test let a nested one's index (a multi-gigabyte index.db plus its
// spool) rank as a search result.
export const isIqDenied = (relPath: string): boolean =>
    DENIED_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`) || relPath.includes(`/${dir}/`) || relPath.endsWith(`/${dir}`));

// The same set as ripgrep -g globs: rg prunes these before the post-filter ever sees them.
export const DENIED_GLOBS = DENIED_DIRS.map((dir) => `!**/${dir}`);
