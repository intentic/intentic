#!/usr/bin/env node
/* NOTHING IN THIS REPOSITORY REMOVES A DIRECTORY THAT AGENT TURNS MOUNT OVER.
 *
 *   node _tools/checks/mirror-roots.mjs      # every package script and every tracked shell script
 *
 * `node_modules`, `dist` and `generated` are the three trees a worktree cannot check out, so an isolated turn
 * gets each of them as an overlayfs mount with the MAIN checkout's copy as its lowerdir. An overlay resolves
 * that lowerdir once, at mount time. Emptying it is harmless; REPLACING it — `rm -rf dist` and a `mkdir` after —
 * hands the path a new inode the mount cannot follow, and every live turn's merged view of that directory then
 * `readdir`s as completely empty, its own upper layer included, unrepairable from inside the turn. The full
 * argument, the measurements and the incident are in @intentic/constants/mirror-roots, which is also where the
 * judgment this runs lives, one copy shared with the daemon's isolation module.
 *
 * WHY A GATE RATHER THAN A LINE IN A README. The command that broke it was `_platform/prisma`'s `build`:
 * `rm -rf ./generated ./dist ./.cache`, written years before any of this existed, entirely reasonable on a
 * developer's laptop, and correct in CI. It only misbehaves when it runs on the main checkout of a machine that
 * is also hosting agent turns, which is every sandbox, and its victim is a DIFFERENT process in a different
 * namespace that fails minutes later with a type error naming a file it can see. Nobody debugging that ends up
 * reading a build script. Worse, the failure lands on the turn-ending check, so it reports as "this turn broke
 * the tree" for every conversation at once — the false-positive gate docs/ci-failure-audit.md is about.
 *
 * WHAT IT READS, and where it stops. Every `scripts` entry of every workspace manifest and of the root manifest
 * (that is what `turbo run build` and `pnpm <script>` execute against the checkout, and it is where the incident
 * was), plus every tracked shell script (all of `_tools/scripts`, the hooks, the installers: the other place a
 * removal is written as a shell command someone runs in the checkout). A Node script that has to clear an output
 * directory does not spell the removal itself — it calls _tools/scripts/build/clean-outputs.mjs, which implements the
 * rule rather than restating it, and which is also the fix this check tells you to apply.
 *
 * A staging tree is not the checkout, and this can tell: `rm -rf "$out/sandbox"` and
 * `rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*` in prepare-image-trees.sh both name something
 * whose last segment is not a mirror root, so neither is reported. The rule is about the mount ROOT, and only
 * about the mount root. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replacedMirrorRoots } from "../constants/src/mirror-roots.mjs";
import { finish } from "./lib/report.mjs";
import { packages, root, trackedFiles } from "./lib/repo.mjs";

const SHELL = /\.(sh|bash)$/;
// The hooks are shell with no extension (git decides their names), and they run in the checkout like any script.
const HOOK_DIR = ".githooks/";

const findings = [];

// The manifests first: `scripts` is a flat object of shell command strings, and the root's own count.
const manifests = [
    { name: "package.json", pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) },
    ...packages.map(({ name, pkg }) => ({ name: `${name}/package.json`, pkg })),
];
for (const { name, pkg } of manifests) {
    for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
        for (const target of replacedMirrorRoots(String(command))) {
            findings.push({ where: `${name} → "${script}"`, target });
        }
    }
}

for (const path of trackedFiles()) {
    if (!SHELL.test(path) && !path.startsWith(HOOK_DIR)) {
        continue;
    }
    let lines;
    try {
        lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    for (const [at, line] of lines.entries()) {
        if (line.trim().startsWith("#")) {
            continue;
        }
        for (const target of replacedMirrorRoots(line)) {
            findings.push({ where: `${path}:${at + 1}`, target });
        }
    }
}

finish(
    [
        [
            "these remove a directory that every isolated turn has mounted as an overlay lower root, which empties it\n" +
                "  for every live agent at once (see @intentic/constants/mirror-roots). Empty it instead:\n" +
                "  `node _tools/scripts/build/clean-outputs.mjs <paths>`, which keeps the inode and drops everything in it",
            findings.map(({ where, target }) => `${where} removes ${target}`),
        ],
    ],
    [`${manifests.length} manifest(s) and every tracked shell script: no mirror root is removed rather than emptied`],
);
