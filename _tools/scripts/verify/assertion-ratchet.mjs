#!/usr/bin/env node
// Refuses a test file that got weaker between two commits, unless the range declares it (`test!:` subject, any scope,
// or a `Test-Note:` trailer) — the same shape _tools/checks/contract-shrink.mjs asks of a shrinking wire contract.
// `--worktree` compares the tree to HEAD and only reports, since there's nothing to declare against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { describeWeakening, measureFile, TEST_FILE, weakened } from "../../constants/src/assertion-measure.mjs";
import { changedPaths, git as gitIn } from "../lib/git.mjs";

const root = repoRoot(import.meta.url);
const args = process.argv.slice(2);
const worktree = args.includes("--worktree");
const [base, head] = args.filter((arg) => !arg.startsWith("--"));
if (!worktree && (base === undefined || head === undefined)) {
    console.error("usage: assertion-ratchet.mjs <base> <head> | --worktree");
    process.exit(2);
}

// Bound to this checkout via lib/git.mjs, which also sets the larger buffer a long `git log` needs.
const git = (...argv) => gitIn(root, ...argv);

// Pairs to compare: `[path, beforeText | undefined, afterText]` for every test file that still exists; a deleted file
// is a deletion, not a weakening.
const pairs = () => {
    if (worktree) {
        return (changedPaths(root) ?? [])
            .filter((path) => TEST_FILE.test(path))
            .flatMap((path) => {
                let after;
                try {
                    after = readFileSync(join(root, path), "utf8");
                } catch {
                    return [];
                }
                return [[path, git("show", `HEAD:${path}`), after]];
            });
    }
    const listing = git("diff", "--name-only", "--diff-filter=AM", base, head) ?? "";
    return listing
        .split("\n")
        .filter((path) => TEST_FILE.test(path))
        .flatMap((path) => {
            const after = git("show", `${head}:${path}`);
            return after === undefined ? [] : [[path, git("show", `${base}:${path}`), after]];
        });
};

// A commit in the range that owns the weakening: `test!:` with any scope, or a `Test-Note:` trailer.
const declared = () => {
    if (worktree) {
        return false;
    }
    const subjects = git("log", "--format=%s", `${base}..${head}`) ?? "";
    const trailers = git("log", "--format=%(trailers:key=Test-Note,valueonly)", `${base}..${head}`) ?? "";
    return /^test(\([^)]*\))?!:/m.test(subjects) || trailers.trim() !== "";
};

const findings = [];
for (const [path, beforeText, afterText] of pairs()) {
    const before = beforeText === undefined ? undefined : measureFile(beforeText, path);
    const after = measureFile(afterText, path);
    const shape = weakened(before, after);
    if (shape !== undefined) {
        findings.push(describeWeakening(path, shape, before, after));
    }
}

if (findings.length === 0) {
    console.error(`assertion-ratchet: no test file got weaker`);
    process.exit(0);
}
console.error(`assertion-ratchet: ${findings.length} test file${findings.length === 1 ? "" : "s"} got weaker:`);
for (const line of findings) {
    console.error(`  ${line}`);
}
if (worktree) {
    console.error(
        `assertion-ratchet: a failing test is fixed by updating the value it expects to the new truth, not by widening the matcher. ` +
            `If the weakening is deliberate, say why in the commit: a \`test!:\` subject or a \`Test-Note:\` trailer.`,
    );
    process.exit(1);
}
if (declared()) {
    console.error(`assertion-ratchet: declared by a \`test!:\` subject or a \`Test-Note:\` trailer in the range, so it passes`);
    process.exit(0);
}
console.error(
    `assertion-ratchet: no commit in the range declares it. Restore the assertions (update the expected value, not the matcher), ` +
        `or, if the weakening is the point, say so: a \`test!:\` subject or a \`Test-Note:\` trailer on one of the commits.`,
);
process.exit(1);
