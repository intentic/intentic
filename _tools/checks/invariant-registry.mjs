#!/usr/bin/env node
/* A registry anyone may contribute to and nobody must is a folder that fills up for two months and is never opened again. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.filename, "../../..");
const src = join(root, "_sandbox/sandbox/src");

// Subsystems not yet audited; removing an entry needs a real or explained invariant.ts. Shrink only.
const UNAUDITED = new Set([
    "activity",
    "approvals",
    "auth",
    "automations",
    "browser",
    "chores",
    "ci",
    "endpoints",
    "environment",
    "execution",
    "extensions",
    "git",
    "guard",
    "hashline",
    "history",
    "intentic",
    "inventory",
    "logs",
    "loops",
    "migrations",
    "panels",
    "personas",
    "portability",
    "ports",
    "processes",
    "public",
    "push",
    "rules",
    "scaffold",
    "secrets",
    "sessions",
    "settings",
    "share",
    "speech",
    "store",
    "system",
    "terminal",
    "trial",
    "usage",
    "vpn",
    "wallet",
    "webchat",
    "workflows",
    "workspace",
]);

// Not subsystems: the registry itself, plus test-scaffolding dirs with no daemon code.
const NOT_A_SUBSYSTEM = new Set(["invariants", "e2e", "harness"]);

const failures = [];
// UNAUDITED entries already resolved: directory gone, or invariant.ts now exists. Logged, not failed.
const retired = [];

const directories = readdirSync(src)
    .filter((entry) => statSync(join(src, entry)).isDirectory())
    .filter((entry) => !NOT_A_SUBSYSTEM.has(entry))
    .sort();

const present = new Set(directories);
for (const entry of UNAUDITED) {
    if (!present.has(entry)) {
        retired.push(`UNAUDITED names '${entry}', which is not a directory under _sandbox/sandbox/src (renamed or removed)`);
    }
}

// Every file other than the invariant module, read once, so rule 4 can check whether anything imports each companion.
const sources = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(path);
        } else if (entry.name.endsWith(".ts") && entry.name !== "invariant.ts") {
            sources.push(readFileSync(path, "utf8"));
        }
    }
};
walk(src);

for (const directory of directories) {
    const companion = join(src, directory, "invariant.ts");
    let body;
    try {
        body = readFileSync(companion, "utf8");
    } catch {
        if (!UNAUDITED.has(directory)) {
            failures.push(
                `'${directory}' has no invariant.ts, register a check, or add an empty companion with a leading "No runtime invariant: <why>" comment`,
            );
        }
        continue;
    }
    if (UNAUDITED.has(directory)) {
        retired.push(`'${directory}' now has an invariant.ts but is still listed as UNAUDITED`);
    }
    // Checks for `checks` structurally; executing the module would mean constructing daemon services.
    const empty = /export const checks[^=]*=\s*(\[\s*\]|\(\s*\)\s*(:[^=]*)?=>\s*\[\s*\])/.test(body);
    if (empty) {
        // The marker opens a line in any of the three comment forms the tree uses: `//`, a block continuation `*`, or a one-line `/*`.
        if (!/^\s*(\/\/|\/?\*)\s*No runtime invariant:/m.test(body)) {
            failures.push(
                `'${directory}' registers no checks and does not say why, add a "No runtime invariant: <why>" comment naming what this subsystem owns that has no observable runtime relationship`,
            );
        }
        continue;
    }
    if (!/\bfail\s*\(/.test(body)) {
        failures.push(`'${directory}' registers checks that never call fail(): a check that cannot report a violation asserts nothing`);
    }
    if (!/\bowner\s*=/.test(body)) {
        failures.push(`'${directory}' exports no owner: the registry attributes every violation by it`);
    }
    const imported = sources.some((source) => source.includes(`${directory}/invariant.js`));
    if (!imported) {
        failures.push(
            `'${directory}/invariant.ts' is imported by nothing: register it (invariants/register.ts, or main.ts for the ones whose subject main learns)`,
        );
    }
}

// Logged so the list gets trimmed on the next edit; never treated as a failure.
for (const line of retired) {
    console.log(`verify-invariants: ${line}: drop it from UNAUDITED when you next edit this file`);
}

if (failures.length > 0) {
    console.error(`verify-invariants: ${failures.length} problem(s)\n`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

// Backlog excludes retired entries, so the summary doesn't undercount how much of the tree is audited.
const backlog = UNAUDITED.size - retired.length;
const audited = directories.length - backlog;
console.log(`verify-invariants: ok, ${audited} of ${directories.length} subsystems audited, ${backlog} in the backlog`);
