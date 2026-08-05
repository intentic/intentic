// Where the index lives, root-relative. Excluded from every view so the index can never surface itself.
export const IQ_DIR = ".intentic/iq";

/* The agent plane's own byproducts, root-relative — never the code a search is about.
 *
 * The index (self-exclusion: it must not surface itself), the session transcripts, the attachment blobs, and
 * the Chromium login profile. Transcript mining showed `.intentic/claude/**.jsonl` outranking source in refs
 * and ask results — an agent's own past conversations answering a question about the codebase.
 *
 * Deliberately NOT the whole `.intentic/` dir: its manifests (settings.json, capabilities.json, the
 * environment Dockerfiles, automations, approvals, drafts) are things a user writes and an agent is regularly
 * asked to find and edit. Excluding those would trade one silent blind spot for another. */
const DENIED_DIRS = [IQ_DIR, ".intentic/claude", ".intentic/attachments", ".intentic/browser"];

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
