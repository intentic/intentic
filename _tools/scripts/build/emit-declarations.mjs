#!/usr/bin/env node
// Compiles every package a check or test imports before either runs, via `tsgo -b` directly rather than through pnpm's
// build (which hardlinks into `node_modules` and dies EXDEV in an agent worktree, a separate filesystem). Lets `pnpm
// test` skip the `^build` turbo edge and still import a current dist.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { emitsDist, packages, root } from "../../checks/lib/repo.mjs";

// Needs declarations only if `exports` hand a dependent a `dist/` module a compiler reads, not `./src/...`.
// `_shared/extension-ui` re-exports `@intentic/ui`, which `tsgo -b` can't walk; its own `build` emits its declarations.
const BUILT_BY_VUE_TSC = new Set(["_shared/extension-ui"]);
const needsDeclarations = packages.filter(({ name, pkg }) => !BUILT_BY_VUE_TSC.has(name) && emitsDist(pkg));

// A package with a `generate` script has nothing for `tsgo -b` to read until it runs, via a shell with its own `.bin`
// on PATH, not pnpm. `--clean` first, or incremental build reuses `.tsbuildinfo`'s stale root list.
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

// pnpm injects a workspace dep as a hardlinked copy in `node_modules/.pnpm`, not a symlink; a rewritten file reaches
// the copy for free (same inode), a newly created one does not. Reconciled here by linking or, across filesystems,
// copying.
const storeDir = join(root, "node_modules/.pnpm");
const mangle = (segment) => segment.replaceAll("/", "+");

// Same inode is never stale; otherwise same size and mtime, rounded to the millisecond since `utimesSync` can't set
// finer.
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
        // EXDEV: worktree `node_modules` is a separate filesystem; stamps mtime so `current` recognizes the copy later.
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
    // Removes a declaration the package no longer emits but the copy still has.
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
    // Mangles `pkg.name` and the package dir into `.pnpm`'s stored folder name; `_<peers>` suffix if resolved with
    // peers.
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
// `written` is 0 when the workspace is already coherent, non-zero only when this pass prevented a stale-import error.
console.log(`injected copies: ${refreshed} reconciled with the dist this pass emitted, ${written} files rewritten`);
