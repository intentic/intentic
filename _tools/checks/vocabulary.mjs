#!/usr/bin/env node
// A word this repository retired may not be spelled again. The measurement behind the list is
// docs/audits/vocabulary-audit.md: `_apps/` and `_libs/` were still being typed 89 times a month after removal, and
// "card" survived its own rename inside the persona screens for exactly as long as nothing read for it.
//
// Exemptions are by REASON, not by path list. `docs/audits/` describes the tree a measurement ran against, so a
// retired word inside one is the record working; docs/design/vocabulary.md is the decision that names what each word
// became and cannot state it without spelling it; `_tools/nav/baselines/` holds recorded measurements of older trees.
// Everything else in the checkout is read.

import { readFileSync,existsSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED, retiredIn } from "../constants/src/vocabulary.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, subjectScope, writesBaselines } from "./lib/repo.mjs";

const BASELINE = join(root, "_tools/checks/baselines/vocabulary.json");
const writeBaseline = process.argv.includes("--write-baseline");

// Text this check can read; a binary or a lockfile carries no prose to fix.
const READABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|astro|css|md|json|toml|yml|yaml|rs|sh|html)$/;
const EXEMPT = [
    { test: (path) => path.startsWith("docs/audits/"), why: "an audit describes the tree it ran against" },
    { test: (path) => path === "docs/design/vocabulary.md", why: "the decision that names what each word became" },
    { test: (path) => path.startsWith("_tools/nav/baselines/"), why: "recorded measurements of trees that had those names" },
    { test: (path) => path === "_tools/constants/src/vocabulary.mjs", why: "the table itself" },
    { test: (path) => path === "_tools/checks/vocabulary.mjs", why: "this file" },
    { test: (path) => path.endsWith("contract.lock.json"), why: "generated from the schemas, not written by hand" },
];
const exemptFor = (path) => EXEMPT.find((rule) => rule.test(path))?.why;

const files = subjectFiles().filter((path) => READABLE.test(path) && exemptFor(path) === undefined);
const found = new Map();
for (const path of files) {
    const findings = retiredIn(readFileSync(join(root, path), "utf8"));
    if (findings.length > 0) {
        found.set(path, findings);
    }
}

// The whole tree's count per file, adopted on request. A scoped run reads a few files and therefore knows nothing
// about the rest, so it may never write: that is what stops one edit erasing a baseline it did not measure.
if (writeBaseline) {
    if (subjectScope() !== undefined) {
        console.error(`vocabulary: --write-baseline adopts the whole tree's findings, so it cannot run under --paths`);
        process.exit(2);
    }
    const adopted = Object.fromEntries([...found].map(([path, findings]) => [path, findings.length]).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(BASELINE, `${JSON.stringify(adopted, undefined, 4)}\n`);
    console.log(`vocabulary: baseline adopts ${Object.keys(adopted).length} file(s)`);
    process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const problems = [];
const next = { ...baseline };
for (const [path, findings] of found) {
    const allowed = baseline[path] ?? 0;
    if (findings.length > allowed) {
        for (const finding of findings) {
            problems.push(`${path}:${finding.line}  "${finding.id}" was retired, say ${finding.became} — ${finding.text}`);
        }
        continue;
    }
    // Beaten, never failed: an entry may tighten to what the tree now holds, so the ratchet only ever closes.
    next[path] = findings.length;
}
// A file that carries none any more loses its entry, outside a scoped run that never looked at the others.
const scope = subjectScope();
for (const path of Object.keys(baseline)) {
    if (!found.has(path) && (scope === undefined || scope.has(path))) {
        delete next[path];
    }
}
if (scope === undefined && writesBaselines() && JSON.stringify(next) !== JSON.stringify(baseline)) {
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1))), undefined, 4)}\n`);
}

finish(
    [["a word this repository retired, spelled again (docs/design/vocabulary.md says what each became)", problems]],
    [`${RETIRED.length} retired words, ${files.length} files read: none of them spelled again`],
);
