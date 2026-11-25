#!/usr/bin/env node
// Test code that leans on the wall clock or a fixed port, polls by hand, loads a module cold inside a test, or raises a
// test's timeout without saying why (the rules and their history: lib/timing-hazards.mjs). Between 2026-10-23 and
// 11-05, 18 of main's 35 red stretches ended with a commit taking one of these out of a test.
//
// Ratcheted per file and rule (baselines/timing-hazards.json, keyed `<path>#<rule>`): the standing count may shrink and
// never grow unasked, so a new one is said back after the edit that writes it rather than as a failing main a week later.
// One that is right where it stands says why with `// allow(timing-hazards): <reason>`. Skipped and focused tests are
// not read here: oxlint's jest/no-disabled-tests and jest/no-focused-tests already refuse them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedAt } from "./lib/allow.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";
import { hazardsIn, RULE_WHY, TEST_FILE } from "./lib/timing-hazards.mjs";

const CHECK = `timing-hazards`;

const files = subjectFiles().filter((path) => TEST_FILE.test(path) && !path.startsWith(`refs/`) && !path.includes(`/node_modules/`));

const found = new Map();
const sites = new Map();
for (const path of files) {
    const text = readFileSync(join(root, path), `utf8`);
    const lines = text.split(`\n`);
    for (const hazard of hazardsIn(path, text)) {
        if (allowedAt(lines, hazard.line, CHECK)) {
            continue;
        }
        const key = `${path}#${hazard.rule}`;
        found.set(key, (found.get(key) ?? 0) + 1);
        sites.set(key, [...(sites.get(key) ?? []), hazard]);
    }
}

// A key names a file and a rule; a change to that file is what can move it.
const { grown } = ratchet(CHECK, CHECK, found, { touchedBy: (key, path) => key.slice(0, key.lastIndexOf(`#`)) === path });
if (ADOPTING) {
    process.exit(0);
}

const problems = grown.flatMap(({ key, count, allowed }) => {
    const path = key.slice(0, key.lastIndexOf(`#`));
    const rule = key.slice(key.lastIndexOf(`#`) + 1);
    return [
        ...sites.get(key).map(({ line, text }) => `${path}:${line}  ${rule}: ${RULE_WHY[rule]} (\`${text}\`)`),
        `${path}: ${count} ${rule} finding(s), the baseline allows ${allowed}`,
    ];
});
const standing = [...found.values()].reduce((sum, count) => sum + count, 0);

finish(
    [[`a new timing hazard in test code: fix it as the line says, or, where it is right, say why with // allow(${CHECK}): <reason>`, problems]],
    [`${files.length} test files read: no new timing hazard (${standing} standing, held by the baseline)`],
);
