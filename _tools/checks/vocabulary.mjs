#!/usr/bin/env node
// A word this repository retired may not be spelled again; `_tools/constants/src/vocabulary.mjs` holds each retired word
// and what replaced it.
//
// Exemptions are by REASON, not by path list: `_tools/nav/baselines/` holds recorded measurements of older trees.
// Everything else in the checkout is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED, retiredIn } from "../constants/src/vocabulary.mjs";
import { finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

// Text this check can read; a binary or a lockfile carries no prose to fix.
const READABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|astro|css|md|json|toml|yml|yaml|rs|sh|html)$/;
const EXEMPT = [
    { test: (path) => path.startsWith("_tools/nav/baselines/"), why: "recorded measurements of trees that had those names" },
    { test: (path) => path === "_tools/constants/src/vocabulary.mjs", why: "the table itself" },
    { test: (path) => path === "_tools/checks/vocabulary.mjs", why: "this file" },
    { test: (path) => path.endsWith("contract.lock.json"), why: "generated from the schemas, not written by hand" },
    { test: (path) => path === "docs/architecture/index.json", why: "generated from the package READMEs, not written by hand" },
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

const { grown } = ratchet("vocabulary", "vocabulary", new Map([...found].map(([path, findings]) => [path, findings.length])));
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key }) =>
    found.get(key).map((finding) => `${key}:${finding.line}  "${finding.id}" was retired, say ${finding.became} — ${finding.text}`),
);

finish(
    [["a word this repository retired, spelled again (_tools/constants/src/vocabulary.mjs says what each became)", problems]],
    [`${RETIRED.length} retired words, ${files.length} files read: none of them spelled again`],
);
