import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* FINDING A ROOT BY LOOKING FOR IT, INSTEAD OF COUNTING THE WAY UP TO IT.
 *
 * Two dozen files used to work out where the monorepo root was by counting how deep they sat: `../..` from a
 * package's own directory, `../../..` from its `src/`, `../../../..` from the installer scripts. Every one of
 * those numbers is correct only for the file's CURRENT depth, and nothing anywhere checks it. Move the file
 * one directory and it silently resolves somewhere else: no import fails, no type breaks; you find out when
 * something reads the wrong .env at runtime, or reads nothing and falls back to a default.
 *
 * Walking up until a marker appears has none of that coupling. A file can sit at any depth, move between
 * packages, or be symlinked in, and still get the same answer.
 *
 * WHY THIS FILE IS HAND-WRITTEN JAVASCRIPT rather than TypeScript compiled to dist, in a package where
 * everything else is compiled: the earliest callers run BEFORE anything is built. `prepass.mjs` is the script
 * that performs the build, and the byte check and the path guard both run ahead of it in `pnpm check`. A
 * helper those three had to import from `dist/` would be a helper they could not import on a clean checkout,
 * which is exactly how the second copy of this walk gets written. Plain .mjs with a hand-written .d.mts beside
 * it is importable at every point in the build, so there only has to be one.
 *
 * A caller that runs before `pnpm install` has one more constraint: `@intentic/constants/node` is a BARE
 * specifier and bare specifiers resolve through node_modules, which a bare checkout has none of. Those callers
 * (`prepass.mjs`, run by the pre-push hook and by CI's preflight job) import THIS FILE by relative path
 * instead. Still one walk; only the way in differs.
 *
 * NOT EXPORTED FROM THE PACKAGE INDEX, and that is deliberate: the index is imported by browser code
 * (Setup.vue reads PLATFORM_WEB_ORIGIN) and must never pull in node:fs. Path VALUES live there; path DISCOVERY
 * lives here, behind the `@intentic/constants/node` subpath. */

// The marker that identifies the monorepo root. pnpm-workspace.yaml rather than package.json or .git: a
// package.json sits in all 78 packages, and .git is absent in an agent worktree's checkout and present in
// unrelated parents. This file exists exactly once, at exactly the directory everyone means by "the root".
const REPO_MARKER = "pnpm-workspace.yaml";

/* Where the caller is, from whichever of the three things it has in hand. `import.meta.url` is a file:// URL
 * and needs converting; `import.meta.dirname` and a bare path are already paths. Accepting all three is what
 * stops a caller reaching for `fileURLToPath(new URL("...", import.meta.url))` out of habit and reintroducing
 * a relative segment on the way in. */
const startDir = (from) => {
    const path = from.startsWith("file:") ? fileURLToPath(from) : resolve(from);
    /* A URL or path naming a FILE has to become its directory; one naming a directory is already there. Asked
     * of the filesystem rather than guessed from the shape, because `.../src/lib` and `.../lib/version.js` are
     * indistinguishable as strings.
     *
     * A path that does not exist is treated as a directory, and costs nothing when it isn't: the walk simply
     * finds no marker at that level and moves to the parent, which is where a non-existent file's directory
     * was all along. */
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === false ? dirname(path) : path;
};

// Walk up from `dir` until `marker` is found beside us, or we run out of parents. Returns "" for not-found so
// each caller decides whether that is fatal: the installers treat it as "not run from a checkout" and carry
// on, while everything inside the repo treats it as impossible and throws.
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

/* THE MONOREPO ROOT, from anywhere inside it. Pass `import.meta.url`: the caller's own location is the only
 * thing this needs, and it is the one thing every module already knows about itself.
 *
 * Throws when the marker is nowhere above the caller, which inside this repo means the checkout is broken. The
 * throw is the point: the counting version's failure mode was to return a WRONG directory confidently, and a
 * wrong directory is how a config loader silently reads no .env and every credential arrives empty. */
export const repoRoot = (from) => {
    const found = walkUp(startDir(from), REPO_MARKER);
    if (found === "") {
        throw new Error(`repoRoot: no ${REPO_MARKER} above ${startDir(from)}, is this a complete checkout?`);
    }
    return found;
};

/* THE CALLING PACKAGE'S OWN ROOT: the directory its package.json sits in. The other thing the dot-counting
 * was reaching for: `createRequire(import.meta.url)("../../package.json")` in three different version.ts files,
 * each with a different number of dots because each sat at a different depth, all of them meaning "mine".
 *
 * Stops at the FIRST package.json above the caller, so a package's own manifest always wins over the root's. */
export const packageRoot = (from) => {
    const found = walkUp(startDir(from), "package.json");
    if (found === "") {
        throw new Error(`packageRoot: no package.json above ${startDir(from)}`);
    }
    return found;
};
