// V8'S COMPILED CODE KEPT ACROSS RUNS, for the per-edit commands (run.mjs --paths, lint-edit.mjs): each is a fresh node
// that compiles the same modules again after every edit, typescript's 9 MB among them, and so does every oxlint it
// starts. With the cache on, a module whose source is unchanged loads from the bytecode node kept for it (node checks
// the source's hash), so what runs and what it answers are the same. Measured on one daemon `.ts` file (2026-11-24):
// the scoped checks 1.6-1.8 s of CPU without it and 1.1-1.3 s with it, the linter 0.40 s and 0.25-0.30 s.
import { enableCompileCache } from "node:module";

/** Turns the cache on for this process and, through NODE_COMPILE_CACHE, for the node processes it starts. */
export const cacheCompiles = () => {
    // A node that cannot keep one (no writable temporary directory, NODE_DISABLE_COMPILE_CACHE) runs without it.
    const { directory } = enableCompileCache?.() ?? {};
    if (directory !== undefined && process.env.NODE_COMPILE_CACHE === undefined) {
        process.env.NODE_COMPILE_CACHE = directory;
    }
};
