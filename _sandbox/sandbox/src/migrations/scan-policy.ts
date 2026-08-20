/* WHAT IS WORTH READING OUT OF A FOREIGN HOME DIRECTORY, and what must never be read at all, one policy, so
 * the two ways in (an uploaded archive, a connected computer read directly) can never disagree about what a
 * setup contains. A user who packs a tarball and a user who lets us read the folder must get the same plan.
 *
 * The segments below are not a size optimization. `credentials/` holds channel state whose ratcheting keys
 * DESYNC the source install if they are copied (OpenClaw's own migration guide warns about exactly this), and
 * `sessions/`/`logs/` are transcripts the design refuses to import at all. Never holding them is stronger than
 * refusing them later: bytes that never enter the daemon cannot be written by a bug downstream. */

// Directory SEGMENTS never worth holding, wherever they sit, both tools' own export tooling excludes these.
export const SKIPPED_SEGMENTS = new Set([
    "sessions",
    "logs",
    "plugins",
    "mcp-tokens",
    "plans",
    "hermes-agent",
    "credentials",
    "runs",
    "node_modules",
    ".git",
    "__pycache__",
    "venv",
    ".venv",
]);

// File suffixes that mean machine state, not setup, databases and their journals.
export const SKIPPED_SUFFIXES = [".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".pyc"];

// A single file larger than this is not configuration. Memory files, skills and configs are kilobytes; the
// megabyte-scale entries in these homes are exactly the state the plan refuses.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* Why a path is not held, worded for the plan's `refused` list, or undefined when it is fine to hold.
 * `relPath` is forward-slash and relative to the home directory's root. */
export const skipReason = (relPath: string, size: number): string | undefined => {
    const parts = relPath.split("/");
    const segment = parts.find((part) => SKIPPED_SEGMENTS.has(part));
    if (segment !== undefined) {
        return `${parts.slice(0, parts.indexOf(segment) + 1).join("/")}/`;
    }
    if (SKIPPED_SUFFIXES.some((suffix) => relPath.endsWith(suffix))) {
        return relPath;
    }
    if (size > MAX_FILE_BYTES) {
        return `${relPath} (too large to be configuration)`;
    }
    return undefined;
};

/* The file names an adapter can actually consume. Used only by the DIRECT read, which pays a network round trip
 * per file and so reads nothing it could not use; an uploaded archive is already in memory, so it holds
 * everything the segments above allow and lets the adapters ignore the rest.
 *
 * The two therefore differ in what they HOLD and not in what they PLAN: every path an adapter looks at
 * (the configs, the .env, the markdown, SKILL.md, the cron store, auth profiles) matches here. A file added to
 * an adapter's reach has to be added here in the same change, the round-trip test over both paths is what
 * catches a miss. */
const READABLE_SUFFIXES = [".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".env"];
export const isReadableName = (name: string): boolean => name === ".env" || READABLE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
