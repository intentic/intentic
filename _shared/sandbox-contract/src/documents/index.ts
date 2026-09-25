// Stored-document evolution shared by everything that keeps a file across versions: the daemon's stores, and an
// extension's own files through `sandboxDocument` (@intentic/extension-api). The vocabulary of guarded, pure
// conversions, the passthrough that keeps what a build does not know on its writes, and the one read (read.ts) that
// puts the two together.
export * from "./conversions.js";
export * from "./passthrough.js";
export * from "./read.js";
