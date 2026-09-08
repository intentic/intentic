import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Finds the monorepo root by walking up to a marker (pnpm-workspace.yaml), not by counting `../..`, which broke
// silently whenever a file moved. Kept out of the package index (browser-safe, no node:fs) and hand-written as plain
// .mjs so callers can import it before install or build.

// Root marker; not package.json (in every package) or .git (absent in a worktree, present in other parents).
const REPO_MARKER = "pnpm-workspace.yaml";

// Caller's directory from a file:// URL, import.meta.dirname, or a bare path; accepting all three avoids callers
// composing their own relative path.
const startDir = (from) => {
    const path = from.startsWith("file:") ? fileURLToPath(from) : resolve(from);
    // Resolved via the filesystem, not guessed from the string; a path that doesn't exist is treated as a directory at
    // no cost.
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === false ? dirname(path) : path;
};

// Walks up from `dir` until `marker` appears beside it, or parents run out (returns ""); callers decide whether that's
// fatal.
const walkUp = (dir, marker) => {
    let current = dir;
    for (;;) {
        if (existsSync(resolve(current, marker))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            return "";
        }
        current = parent;
    }
};

// Monorepo root from anywhere inside it (pass import.meta.url). Throws if the marker is nowhere above, rather than
// resolving to a confidently wrong directory.
export const repoRoot = (from) => {
    const found = walkUp(startDir(from), REPO_MARKER);
    if (found === "") {
        throw new Error(`repoRoot: no ${REPO_MARKER} above ${startDir(from)}, is this a complete checkout?`);
    }
    return found;
};

// Caller's own package root: the directory nearest above it holding a package.json. Stops at the first match, so a
// package's own manifest always wins over the root's.
export const packageRoot = (from) => {
    const found = walkUp(startDir(from), "package.json");
    if (found === "") {
        throw new Error(`packageRoot: no package.json above ${startDir(from)}`);
    }
    return found;
};
