// Where the index lives, root-relative. Excluded from every view so the index can never surface itself.
export const IQ_DIR = ".intentic/iq";

// The engine's always-on floor: self-exclusion of the index dir so it can never surface itself. Every engine
// (sweep, ripgrep, git, cursor replay) filters emitted paths through this — `--ignored` never lifts it.
export const isIqDenied = (relPath: string): boolean => relPath === IQ_DIR || relPath.startsWith(`${IQ_DIR}/`);
