#!/usr/bin/env node
// Compiles every package a check or test imports before either runs, via `tsc -b` directly rather than through pnpm's
// build (which hardlinks into `node_modules` and dies EXDEV in an agent worktree, a separate filesystem). Lets `pnpm
// test` skip the `^build` turbo edge and still import a current dist.
//
// `emit-declarations.mjs [<package>...]`: no argument builds every such package; arguments (a directory such as
// `_tools/base`, or a name such as `@intentic/base`) build only those, and whatever their tsconfig references, which
// `tsc -b` brings up to date by itself. That is what `suites` and the daemon's after-land rebuild hand it: just the
// stale packages (dist-staleness.mjs), where the whole set took 11 s at p50 and 41 s at p90 in agents' worktrees.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { emitsDist, packages, root } from "../../checks/lib/repo.mjs";
import { scopedPackages } from "./emit-scope.mjs";

// Needs declarations only if `exports` hand a dependent a `dist/` module a compiler reads, not `./src/...`.
// `_shared/extension-ui` re-exports `@intentic/ui`, which `tsc -b` can't walk; its own `build` emits its declarations.
const BUILT_BY_VUE_TSC = new Set(["_shared/extension-ui"]);
const needsDeclarations = packages.filter(({ name, pkg }) => !BUILT_BY_VUE_TSC.has(name) && emitsDist(pkg));

const scope = scopedPackages(needsDeclarations, process.argv.slice(2));
if ("unknown" in scope) {
    console.log(`emit-declarations: not a package dependents read from dist: ${scope.unknown.join(", ")}`);
    process.exit(2);
}

// A package with a `generate` script has nothing for `tsc -b` to read until it runs, via a shell with its own `.bin`
// on PATH, not pnpm. `--clean` first, or incremental build reuses `.tsbuildinfo`'s stale root list. Scoped, only the
// ones the asked-for packages read: `--clean` throws their whole output away, which is no part of rebuilding another.
const generated = scope.reads.filter(({ pkg }) => pkg.scripts?.generate !== undefined);
for (const { name, dir, pkg } of generated) {
    console.log(`generating: ${name}`);
    const bin = [join(dir, "node_modules/.bin"), join(root, "node_modules/.bin"), process.env.PATH].join(":");
    const generate = spawnSync(pkg.scripts.generate, { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, PATH: bin } });
    if (generate.status !== 0) {
        process.exit(generate.status ?? 1);
    }
}

const tsc = join(root, "node_modules/.bin/tsc");
if (generated.length > 0) {
    const clean = spawnSync(tsc, ["-b", "--clean", ...generated.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
    if (clean.status !== 0) {
        process.exit(clean.status ?? 1);
    }
}

console.log(
    scope.selected.length === needsDeclarations.length
        ? `declarations: building ${needsDeclarations.length} packages that dependents read from dist`
        : `declarations: building ${scope.selected.map(({ name }) => name).join(", ")} and what they reference`,
);
const build = spawnSync(tsc, ["-b", ...scope.selected.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
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
