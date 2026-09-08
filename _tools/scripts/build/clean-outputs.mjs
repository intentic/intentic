#!/usr/bin/env node
// Clears a build output without giving its directory a new inode, the one way this repo may empty a `dist`,
// `generated`, or `node_modules`. A mirrored directory (@intentic/constants/mirror-roots) is emptied in place since
// agent worktrees overlay-mount it; anything else is removed outright. `--sweep <names...>` walks the repo instead of
// taking explicit paths.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { MIRRORED_DIRS } from "../../constants/src/mirror-roots.mjs";
import { repoRoot } from "../../constants/src/node.mjs";

const args = process.argv.slice(2);
const sweep = args[0] === "--sweep";
const targets = sweep ? args.slice(1) : args;
if (targets.length === 0) {
    console.error("clean-outputs: nothing named; pass paths, or --sweep followed by directory names");
    process.exit(2);
}

let emptied = 0;
let removed = 0;

// Empties a mirrored directory in place; removes anything else (a `.cache`, a `.turbo`) outright.
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

// Prunes `node_modules` and `.git` while walking: descending into an installed tree means walking a huge number of
// paths, and on `cache:clear` (which leaves `node_modules` alone) would gut every installed package.
const PRUNED = new Set(["node_modules", ".git"]);
const root = repoRoot(import.meta.url);
const wanted = new Set(targets);
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        // Matched name is cleared, not descended into, even if it's also a pruned name.
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
