// One policy for what is worth reading out of a foreign home directory, shared by an uploaded archive and a direct
// device read so both produce the same plan. `credentials/` ratchets state that desyncs the source install if copied;
// `sessions/` and `logs/` are transcripts never imported; never holding them is safer than refusing them later.

// Directory segments never worth holding, wherever they sit in the tree.
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

// File suffixes that mark machine state, not setup: databases and their journals.
export const SKIPPED_SUFFIXES = [".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".pyc"];

// A file this large is not configuration; memory files, skills and configs run kilobytes, not megabytes.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Why a path is refused, worded for the plan's `refused` list, or undefined when it may be held. `relPath` is
// forward-slash, relative to the home directory root.
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

// File names the direct read may fetch; must match every path an adapter reads. Add a suffix here in the same change
// that adds it to an adapter, or the round-trip test across both paths won't catch the miss.
const READABLE_SUFFIXES = [".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".env"];
export const isReadableName = (name: string): boolean => name === ".env" || READABLE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
