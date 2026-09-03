#!/usr/bin/env node
/* EVERY PACKAGE A CHECK READS, OR A TEST IMPORTS, IS COMPILED BEFORE EITHER RUNS: the emit half of what used
 * to be one `prepass.mjs`. The checks that used to share the file are their own processes now
 * (_tools/checks/, run by run.mjs); this is the part that WRITES into the tree.
 *
 * turbo models this as `dependsOn ["^build"]`, which is correct and unrunnable outside CI: `build` goes through
 * pnpm, pnpm's `syncInjectedDepsAfterScripts` hardlinks into `node_modules` after it, and in an agent worktree
 * `node_modules` is a different filesystem, so the compile succeeds and the run dies EXDEV (exit 238). EVERY
 * agent runs in a worktree. `tsgo -b` writes the same output without pnpm in the path, so it works in a
 * worktree and in CI alike: same command, same result, both places. It is what lets `pnpm test` skip the
 * `^build` edge (`turbo run test --only`) and still have every suite import a CURRENT dependency rather than
 * whatever the main checkout last compiled: ~40s cold, ~1s when nothing moved.
 *
 * Skipping this is worse than not checking at all. Run against the dist a worktree inherits, `_sandbox/sandbox`
 * reported 19 errors, of which 16 were stale declarations and 3 were real. Output like that is what teaches
 * everyone to read a red type check as "baseline failures" and land anyway. */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { emitsDist, packages, root } from "../checks/lib/repo.mjs";

/* A package needs building exactly when its `exports` hand a dependent a MODULE out of `dist/`: that `.js` is
 * what a dependent's compiler reads (through the `.d.ts` beside it). The ones that export `./src/...` (the Vue
 * libraries) are already the source of truth and have nothing to emit. The module part is the whole test:
 * `_editor/share-view` exports `./page` as `./dist/index.html`, a page Vite builds and no compiler reads.
 *
 * AND ONE PACKAGE IS EXEMPT, for the Vue-SFC reason arriving from the other direction. `@intentic/extension-ui`
 * is a curated re-export of `@intentic/ui`, a component graph, so `tsgo -b` walks straight into it and reports
 * a TS2307 for every one, on a package whose own `vue-tsc` typecheck is clean. Its declarations are built by
 * its own `build` script, and nothing in this repo reads them. */
const BUILT_BY_VUE_TSC = new Set(["_editor/extension-ui"]);
const needsDeclarations = packages.filter(({ name, pkg }) => !BUILT_BY_VUE_TSC.has(name) && emitsDist(pkg));

/* A package whose sources are themselves GENERATED has nothing for `tsgo -b` to read until its generator has
 * run: `_platform/prisma` is one re-export of `./generated/client.js`. Recognized by shape (a `generate`
 * script), not by name, and run through a shell with the package's own `.bin` on PATH rather than through
 * pnpm, for the EXDEV reason above. Generation is unconditional: ~0.8s, and a conditional pass would have to
 * model each generator's inputs. `--clean` first, because native TypeScript's incremental build otherwise
 * reuses the old root list from `.tsbuildinfo` (TS6307 on a freshly generated module). */
const generated = needsDeclarations.filter(({ pkg }) => pkg.scripts?.generate !== undefined);
for (const { name, dir, pkg } of generated) {
    console.log(`generating: ${name}`);
    const bin = [join(dir, "node_modules/.bin"), join(root, "node_modules/.bin"), process.env.PATH].join(":");
    const generate = spawnSync(pkg.scripts.generate, { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, PATH: bin } });
    if (generate.status !== 0) {
        process.exit(generate.status ?? 1);
    }
}

const tsgo = join(root, "node_modules/.bin/tsgo");
if (generated.length > 0) {
    const clean = spawnSync(tsgo, ["-b", "--clean", ...generated.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
    if (clean.status !== 0) {
        process.exit(clean.status ?? 1);
    }
}

console.log(`declarations: building ${needsDeclarations.length} packages that dependents read from dist`);
const build = spawnSync(tsgo, ["-b", ...needsDeclarations.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}

/* AND THE COPIES PNPM MADE OF THAT DIST HAVE TO BE TOLD, because a workspace package here is INJECTED rather
 * than symlinked (`injectWorkspacePackages: true`): `node_modules/.pnpm/<pkg>@file+<path>/node_modules/<pkg>`
 * is a tree of HARD LINKS to the package's own files, taken once, at install time. A file this pass REWRITES
 * reaches the copy for free, same inode. A file it CREATES does not reach it at all, and `skipLibCheck`
 * swallows the missing module inside the .d.ts and re-reports it against the CONSUMER's import as TS2305,
 * naming source that is correct in git, in a package that did not change. pnpm does this itself only after a
 * package's own `build` SCRIPT (`syncInjectedDepsAfterScripts`), which this pass bypasses; so it is done here,
 * with the fallback pnpm's version lacks: link where the store shares a filesystem with the package, copy
 * where an agent worktree means it does not. */
const storeDir = join(root, "node_modules/.pnpm");
const mangle = (segment) => segment.replaceAll("/", "+");

// One inode IS one file and cannot be stale. Failing that, size and mtime, rounded to the millisecond on both
// sides: the emitted file carries the filesystem's nanoseconds and `utimesSync` stamps to the millisecond.
const current = (wrote, dst) => {
    if (!existsSync(dst)) {
        return false;
    }
    const held = statSync(dst);
    return held.ino === wrote.ino || (held.size === wrote.size && Math.round(held.mtimeMs) === Math.round(wrote.mtimeMs));
};

let written = 0;
const place = (src, dst, wrote) => {
    written += 1;
    rmSync(dst, { force: true });
    try {
        linkSync(src, dst);
    } catch {
        // EXDEV: an agent worktree mounts its own `node_modules` from an overlay, so no link can span the two
        // filesystems. Stamping the mtime is what lets `current` recognize this copy next time.
        copyFileSync(src, dst);
        utimesSync(dst, wrote.atime, wrote.mtime);
    }
};

const mirror = (from, to) => {
    mkdirSync(to, { recursive: true });
    const emitted = new Set();
    for (const child of readdirSync(from, { withFileTypes: true })) {
        emitted.add(child.name);
        const src = join(from, child.name);
        const dst = join(to, child.name);
        if (child.isDirectory()) {
            mirror(src, dst);
            continue;
        }
        const wrote = statSync(src);
        if (!current(wrote, dst)) {
            place(src, dst, wrote);
        }
    }
    // The other direction of the same staleness: a declaration the package no longer emits is still a file the
    // copy will happily resolve an import to.
    for (const orphan of readdirSync(to)) {
        if (!emitted.has(orphan)) {
            rmSync(join(to, orphan), { force: true, recursive: true });
        }
    }
};

let refreshed = 0;
for (const { name, dir, pkg } of existsSync(storeDir) ? needsDeclarations : []) {
    const dist = join(dir, "dist");
    if (!existsSync(dist)) {
        continue;
    }
    // `@intentic/sandbox-contract` at `_sandbox/sandbox-contract` is stored as
    // `@intentic+sandbox-contract@file+_sandbox+sandbox-contract`, plus `_<peers>` when the resolution has any.
    const prefix = `${mangle(pkg.name)}@file+${mangle(name)}`;
    for (const stored of readdirSync(storeDir)) {
        if (stored !== prefix && !stored.startsWith(`${prefix}_`)) {
            continue;
        }
        const copy = join(storeDir, stored, "node_modules", pkg.name);
        if (existsSync(join(copy, "package.json"))) {
            mirror(dist, join(copy, "dist"));
            refreshed += 1;
        }
    }
}
// `written` is the interesting half: it is 0 on a workspace that is already coherent, and non-zero exactly
// when this pass has just spared somebody a type error naming a package they did not touch.
console.log(`injected copies: ${refreshed} reconciled with the dist this pass emitted, ${written} files rewritten`);
