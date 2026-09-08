#!/usr/bin/env node
// Checks that every alias target (fromRoot/here in *.config.ts, tsconfig paths) resolves to a real file; usage: node
// _tools/checks/alias-targets.mjs. An alias bypasses the package's exports map, so a moved target type-checks green and
// fails only at load, in whichever importer runs first.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

const CONFIG = /(?:\.config\.(?:ts|mts|mjs)|source-aliases\.ts)$/;
// `fromRoot("_editor/ui/src/x.ts")` — repo-relative; `here("../../_shared/x")` — relative to the config.
const FROM_ROOT = /\bfromRoot\(\s*[`"']([^`"']+)[`"']\s*\)/g;
const HERE = /\bhere\(\s*[`"']([^`"']+)[`"']\s*\)/g;

const findings = [];
let checked = 0;
const tracked = trackedFiles();

// A tsconfig `paths` entry; read by regex, not JSON, since these files carry comments and trailing commas.
const TSCONFIG_PATH = /\[\s*"((?:\.\.?\/)[^"]+)"\s*\]/g;
for (const path of tracked.filter((entry) => /(^|\/)tsconfig[^/]*\.json$/.test(entry))) {
    const text = readFileSync(join(root, path), "utf8");
    for (const match of text.matchAll(TSCONFIG_PATH)) {
        // `include`/`exclude` entries are globs: matching nothing today just means nobody has written that file yet.
        if (match[1].includes("*")) {
            continue;
        }
        checked++;
        if (!existsSync(resolve(join(root, dirname(path)), match[1]))) {
            findings.push(`${path}: ${match[1]}`);
        }
    }
}

const configs = tracked.filter((path) => CONFIG.test(path));
for (const path of configs) {
    const text = readFileSync(join(root, path), "utf8");
    for (const [pattern, base] of [
        [FROM_ROOT, root],
        [HERE, join(root, dirname(path))],
    ]) {
        for (const match of text.matchAll(pattern)) {
            // The same helpers also name where a build writes (outDir, publicDir); only inputs claim the checkout has
            // it.
            const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
            // A path with `${...}` is a shape the config computes per package, not a location this repo spells.
            if (/\b(outDir|publicDir|cacheDir|emptyOutDir|dir)\s*:/.test(line) || match[1].includes("${")) {
                continue;
            }
            checked++;
            const target = resolve(base, match[1]);
            if (!existsSync(target)) {
                findings.push(`${path}: ${match[1]}`);
            }
        }
    }
}

finish(
    [
        [
            "these resolver aliases name a path that does not exist, which fails at LOAD rather than at compile\n" +
                "  (the alias bypasses the exports map the type-checker reads): repoint them, or derive the map from\n" +
                "  the package's own exports with packageSourceAliases from @intentic/testing/aliases",
            findings,
        ],
    ],
    [`${configs.length} config file(s), ${checked} alias target(s): every one exists`],
);
