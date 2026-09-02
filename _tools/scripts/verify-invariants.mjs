#!/usr/bin/env node
/* THE GATE THAT MAKES THE INVARIANT REGISTRY MEAN SOMETHING.
 *
 * A registry anyone may contribute to and nobody must is a folder that fills up for two months and is never
 * opened again. So every subsystem under the daemon's src/ answers the question exactly once: it either registers
 * a check, or it says in writing why it has none. A directory that does neither fails this gate, which is how a
 * NEW subsystem (the ones most likely to own state nobody has thought about yet) is forced to answer on the
 * commit that introduces it rather than never.
 *
 * WHAT IT REFUSES, and why each rule exists rather than being left to review:
 *
 *   1. A subsystem directory with no `invariant.ts` and no entry in UNAUDITED below. The backlog is deliberately
 *      a list in this file rather than an absent check: 50 directories that predate the mechanism are a debt to
 *      be worked down in the open, not a silence to be mistaken for coverage.
 *   2. An `invariant.ts` exporting no checks and carrying no `No runtime invariant:` reason. An empty companion
 *      is a legitimate and common answer: pure functions, thin wrappers, composition-only directories, but an
 *      unexplained one is indistinguishable from an unfinished one.
 *   3. A companion with checks that never calls `fail`. A check that cannot report is a green light with no
 *      subject, which is worse than no check at all.
 *   4. A companion nobody imports. A file that is written and never wired runs never and reads as covered.
 *   5. An UNAUDITED entry naming a directory that no longer exists: a backlog that outlives its subject is how a
 *      list like this quietly stops describing anything.
 *
 * Deliberately NOT checked: whether a check is any good. That is review's job, and a gate that tried would only
 * teach people to write checks shaped like whatever it measured.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.filename, "../../..");
const src = join(root, "_sandbox/sandbox/src");

/* The subsystems that predate the invariant registry and have not yet been audited. Each entry is a promise to
 * come back, not a verdict that there is nothing to check: removing one means writing its `invariant.ts`, empty
 * with a reason or full with a check. Shrink this list; never grow it. */
const UNAUDITED = new Set([
    "acp",
    "activity",
    "approvals",
    "auth",
    "automations",
    "browser",
    "chores",
    "ci",
    "claude",
    "codex",
    "endpoints",
    "environment",
    "execution",
    "extensions",
    "gemini",
    "git",
    "grok",
    "guard",
    "hashline",
    "history",
    "hosts",
    "intentic",
    "inventory",
    "kimi",
    "logs",
    "loops",
    "migrations",
    "panels",
    "personas",
    "pi",
    "portability",
    "ports",
    "prepush",
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

// Not subsystems: the registry itself, and anything that is not a directory of daemon code.
const NOT_A_SUBSYSTEM = new Set(["invariants"]);

const failures = [];

const directories = readdirSync(src)
    .filter((entry) => statSync(join(src, entry)).isDirectory())
    .filter((entry) => !NOT_A_SUBSYSTEM.has(entry))
    .sort();

const present = new Set(directories);
for (const entry of UNAUDITED) {
    if (!present.has(entry)) {
        failures.push(
            `UNAUDITED names '${entry}', which is not a directory under _sandbox/sandbox/src: renamed or removed? update the list in ${"_tools/scripts/verify-invariants.mjs"} in the same change`,
        );
    }
}

// Every file that could import a companion, read once: rule 4 asks whether anything references each one.
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
        failures.push(`'${directory}' now has an invariant.ts but is still listed as UNAUDITED: remove it from that list in the same change`);
    }
    // "Has checks" is read structurally rather than by executing the module: the companions are factories over
    // daemon services, and a gate that had to construct those would be a second composition root.
    const empty = /export const checks[^=]*=\s*(\[\s*\]|\(\s*\)\s*(:[^=]*)?=>\s*\[\s*\])/.test(body);
    if (empty) {
        if (!/^\s*(\/\/|\*)\s*No runtime invariant:/m.test(body)) {
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

if (failures.length > 0) {
    console.error(`verify-invariants: ${failures.length} problem(s)\n`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

const audited = directories.length - UNAUDITED.size;
console.log(`verify-invariants: ok, ${audited} of ${directories.length} subsystems audited, ${UNAUDITED.size} in the backlog`);
