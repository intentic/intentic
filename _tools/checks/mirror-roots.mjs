#!/usr/bin/env node
// An overlayfs mount resolves its lowerdir once, so replacing a mirror root (`rm -rf` then recreate, not emptying)
// leaves every live agent turn's view of it unreadably empty. Checks every script and shell file for that pattern; use
// `_tools/scripts/build/clean-outputs.mjs` instead, which empties without replacing the inode.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replacedMirrorRoots } from "../constants/src/mirror-roots.mjs";
import { finish } from "./lib/report.mjs";
import { packages, root, trackedFiles } from "./lib/repo.mjs";

const SHELL = /\.(sh|bash)$/;
// Hooks are shell with no extension (git decides their names), but run in the checkout like any script.
const HOOK_DIR = ".githooks/";

const findings = [];

// `scripts` is a flat object of shell command strings, root manifest included.
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
