#!/usr/bin/env node
/* THE ASSERTION RATCHET AT THE PUSH: a test file may get stronger by itself, and weaker only on purpose.
 *
 *   node _tools/scripts/assertion-ratchet.mjs <base> <head>      the test files a range changed, committed content
 *   node _tools/scripts/assertion-ratchet.mjs --worktree          the test files the working tree changed, vs HEAD
 *
 * The measure itself, and why it exists, is @intentic/constants/assertion-measure (the daemon reads the same copy). This file is the gate around it: it pairs each
 * changed test file with its earlier self and REFUSES ONLY AN UNDECLARED WEAKENING. A commit in the range whose
 * subject is `test!:` (any scope) or that carries a `Test-Note:` trailer says "I meant it, and here is why", the
 * same shape the wire-contract gate asks of a shrink (_tools/checks/contract-shrink.mjs). In `--worktree` mode there are no
 * commits to declare with, so a flag is a report rather than a refusal, and the exit code says which.
 *
 * Run from verify-push.mjs in its first tier, over the range the push carries. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { describeWeakening, measure, weakened } from "../constants/src/assertion-measure.mjs";

const root = repoRoot(import.meta.url);
const args = process.argv.slice(2);
const worktree = args.includes("--worktree");
const [base, head] = args.filter((arg) => !arg.startsWith("--"));
if (!worktree && (base === undefined || head === undefined)) {
    console.error("usage: assertion-ratchet.mjs <base> <head> | --worktree");
    process.exit(2);
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const git = (...argv) => {
    const result = spawnSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
};

// The pairs to compare: `[path, beforeText | undefined, afterText]` for every test file the range (or the tree)
// changed and still has. A deleted test file is not a weakening of anything; it is a deletion, which review sees.
const pairs = () => {
    if (worktree) {
        const listing = git("status", "--porcelain", "--untracked-files=all") ?? "";
        return listing
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3).trim())
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
    const before = beforeText === undefined ? undefined : measure(beforeText);
    const after = measure(afterText);
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
