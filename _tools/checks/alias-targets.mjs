#!/usr/bin/env node
/* EVERY MODULE ALIAS POINTS AT A FILE THAT EXISTS.
 *
 *   node _tools/checks/alias-targets.mjs
 *
 * A resolver alias is the one path pin in this repository that fails SILENTLY in the direction that matters.
 * `vite`/`vitest` are told to resolve a workspace package to a sibling's source, so the alias bypasses the
 * package's `exports` map — which means the compiler, which reads that map, cannot see the alias at all. A
 * target that moved therefore type-checks green and fails at LOAD, in every suite of the package that owns the
 * alias, pointing at whichever importer happened to be first.
 *
 * Measured: grouping the wire contract's 96 loose modules into `ids/ policy/ state/ text/ protocol/` broke one
 * directory alias in the daemon's vitest config and took 178 suites down with it, while `tsgo --noEmit` stayed
 * green on the same tree. This gate is the reader that would have caught it in a second.
 *
 * WHAT IT READS: every `fromRoot("…")` and `here("…")` argument in the config files that build alias maps
 * (`*.config.ts`, `*.config.mts`, `source-aliases.ts`), and every target in a tsconfig's `paths` — the
 * type-checker's own half of the same map, which drifts the same way and fails as "cannot find module" against
 * a package that is right there. Anything that resolves to a directory or a file is fine; anything that
 * resolves to nothing is the finding. Deliberately not a resolver: it does not care what a specifier means,
 * only that a path this repo spells still exists. */
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

/* A tsconfig `paths` entry: `"@intentic/ui/dag": ["../../_editor/ui/src/components/charts/dagLayout.ts"]`.
 * Read with a regular expression rather than a JSON parser for the reason lib/lockfile.mjs gives — these files
 * carry comments and trailing commas, and this check runs before any install. */
const TSCONFIG_PATH = /\[\s*"((?:\.\.?\/)[^"]+)"\s*\]/g;
for (const path of tracked.filter((entry) => /(^|\/)tsconfig[^/]*\.json$/.test(entry))) {
    const text = readFileSync(join(root, path), "utf8");
    for (const match of text.matchAll(TSCONFIG_PATH)) {
        // `include`/`exclude` are single-element arrays too, and theirs are GLOBS: a pattern that matches
        // nothing today is not a broken pin, it is a directory nobody has written a file into yet.
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
            // The same helpers also name where a build WRITES (`outDir`, `publicDir`), which is a path that
            // legitimately does not exist until something builds. Only inputs are claims about the checkout.
            const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
            // A path with an interpolation in it is a SHAPE the config computes per package (the extension
            // alias map reads each extension's own manifest), not a location this repo spells.
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
