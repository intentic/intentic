#!/usr/bin/env node
/* CLEAR A BUILD OUTPUT WITHOUT REPLACING IT, the one way this repository is allowed to throw away a `dist`, a
 * `generated` or a `node_modules`.
 *
 *   node _tools/scripts/clean-outputs.mjs ./generated ./dist ./.cache    named paths, relative to the cwd
 *   node _tools/scripts/clean-outputs.mjs --sweep .cache dist .turbo     every entry with one of those NAMES
 *
 * WHY THIS EXISTS AT ALL, since `rm -rf` is one word shorter. Every isolated turn runs in a mount namespace
 * where each of those directories is an overlayfs mount whose LOWERDIR is the main checkout's copy of it
 * (_sandbox/sandbox/src/agents/isolation.ts). An overlay resolves its lowerdir once, at mount time. Rewriting
 * the files inside is fine and the merged view follows along; giving the directory a NEW INODE is not, and
 * leaves every live turn's merged view reading as completely empty — upper layer included — with no way to
 * repair it short of a umount/mount that nothing inside the turn can perform.
 *
 * `rm -rf ./generated` in `_platform/prisma`'s build script is the incident: run on the main tree by `turbo run
 * build`, it emptied that package's `generated` overlay in every agent worktree at once, so the declarations
 * emit failed TS6307 on `generated/client.ts` — a file sitting right there, `stat`-able, in a directory that
 * `readdir` swore was empty — on the turn-ending check of every conversation regardless of what it had changed.
 * The full argument, and the measurements behind it, are in @intentic/constants/mirror-roots.
 *
 * So a mirrored directory is EMPTIED (its own inode survives, every child goes) and anything else is removed
 * outright, which is what makes this a drop-in for the `rm -rf` it replaces. A missing mirrored directory is
 * CREATED rather than skipped: the caller's next step is a build that writes into it, and creating it here,
 * before any turn could have mounted over it, is free — creating it later is the very inode swap this refuses.
 *
 * _tools/checks/mirror-roots.mjs is the gate: it refuses a `rm -rf <mirror root>` anywhere a shell command in
 * this repository spells one, and names this script as the shape to use instead. */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
// By file, not by package name, for the reason _tools/checks/lib/repo.mjs gives: a bare specifier resolves
// through node_modules, and this is the first step of a package's `build` and of the root's `clear` — the two
// moments where an install is exactly what may be missing or half-written.
import { MIRRORED_DIRS } from "../constants/src/mirror-roots.mjs";
import { repoRoot } from "../constants/src/node.mjs";

const args = process.argv.slice(2);
const sweep = args[0] === "--sweep";
const targets = sweep ? args.slice(1) : args;
if (targets.length === 0) {
    console.error("clean-outputs: nothing named; pass paths, or --sweep followed by directory names");
    process.exit(2);
}

let emptied = 0;
let removed = 0;

// The mirror-root rule, applied to one path: keep the directory, drop everything in it. Anything else — a
// `.cache`, a `.turbo`, a `dist.zip` — is nobody's mount and goes whole.
const clear = (path, name) => {
    if (MIRRORED_DIRS.has(name)) {
        mkdirSync(path, { recursive: true });
        for (const child of readdirSync(path)) {
            rmSync(join(path, child), { recursive: true, force: true });
        }
        emptied += 1;
        return;
    }
    rmSync(path, { recursive: true, force: true });
    removed += 1;
};

if (!sweep) {
    for (const target of targets) {
        const path = resolve(target);
        clear(path, basename(path));
    }
    console.log(`clean-outputs: ${emptied} emptied in place, ${removed} removed`);
    process.exit(0);
}

/* THE SWEEP, for the root's `clear` and `cache:clear`. Pruning is what the `find` this replaces did and is not
 * an optimisation: an installed tree holds a `dist` and a `.cache` for thousands of third-party packages, so a
 * sweep that descended into one would walk a quarter of a million paths in order to delete files that are about
 * to go with their parent — and on `cache:clear`, which leaves `node_modules` alone, it would quietly gut every
 * installed package instead. `.git` is pruned for the same reason and one more: nothing under it is output. */
const PRUNED = new Set(["node_modules", ".git"]);
const root = repoRoot(import.meta.url);
const wanted = new Set(targets);
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        // A matched name is cleared and never descended into, whether it is one of the pruned trees or not.
        if (wanted.has(entry.name)) {
            clear(path, entry.name);
            continue;
        }
        if (entry.isDirectory() && !PRUNED.has(entry.name)) {
            walk(path);
        }
    }
};
walk(root);
console.log(`clean-outputs: ${emptied} emptied in place, ${removed} removed`);
