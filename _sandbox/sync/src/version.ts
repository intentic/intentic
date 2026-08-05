// The agent build, reported in the machine report so a computer running an old binary is visible on the sandbox's
// Computers row rather than mysteriously lacking a field. A literal, not a package.json read: the shipped
// artifact is a single compiled binary with no package.json beside it to read (same as @intentic/host's).
export const SYNC_VERSION = "0.1.0";
