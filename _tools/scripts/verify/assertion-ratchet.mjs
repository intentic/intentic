#!/usr/bin/env node
// Refuses a test file that got weaker between two commits, unless the range declares it (`test!:` subject, any scope,
// or a `Test-Note:` trailer) — the same shape _tools/checks/contract-shrink.mjs asks of a shrinking wire contract.
// `--since <base>` measures the working tree, committed or not, against `base` (the land verify's own range).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { describeWeakening, measureFile, TEST_FILE, weakened } from "../../constants/src/assertion-measure.mjs";
import { changedSince, git } from "../lib/git.mjs";

const readOr = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
};

// `[path, before | undefined, after]` per test file the range left standing; a deleted file is a deletion, not a weakening.
const committedPairs = (root, base, head) =>
    (git(root, "diff", "--name-only", "--diff-filter=AM", base, head) ?? "")
        .split("\n")
        .filter((path) => TEST_FILE.test(path))
        .flatMap((path) => {
            const after = git(root, "show", `${head}:${path}`);
            return after === undefined ? [] : [[path, git(root, "show", `${base}:${path}`), after]];
        });

// The same pairs for the working tree against `base`, whatever of it is committed.
const treePairs = (root, base) =>
    (changedSince(root, base) ?? [])
        .filter((path) => TEST_FILE.test(path))
        .flatMap((path) => {
            const after = readOr(join(root, path));
            return after === undefined ? [] : [[path, git(root, "show", `${base}:${path}`), after]];
        });

// Whether a commit in `base..head` owns a weakening: `test!:` with any scope, or a `Test-Note:` trailer.
export const declaredIn = (root, base, head) => {
    const subjects = git(root, "log", "--format=%s", `${base}..${head}`) ?? "";
    const trailers = git(root, "log", "--format=%(trailers:key=Test-Note,valueonly)", `${base}..${head}`) ?? "";
    return /^test(\([^)]*\))?!:/m.test(subjects) || trailers.trim() !== "";
};

// Test files weaker at `head` (the working tree when omitted) than at `base`, one line each, and whether the range owns them.
export const weakenings = (root, base, head) => {
    const findings = (head === undefined ? treePairs(root, base) : committedPairs(root, base, head)).flatMap(([path, beforeText, afterText]) => {
        const before = beforeText === undefined ? undefined : measureFile(beforeText, path);
        const after = measureFile(afterText, path);
        const shape = weakened(before, after);
        return shape === undefined ? [] : [describeWeakening(path, shape, before, after)];
    });
    return { findings, declared: findings.length > 0 && declaredIn(root, base, head ?? "HEAD") };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const root = repoRoot(import.meta.url);
    const args = process.argv.slice(2);
    const since = args.indexOf("--since") === -1 ? undefined : args[args.indexOf("--since") + 1];
    const [base, head] = since === undefined ? args : [since, undefined];
    if (base === undefined || (since === undefined && head === undefined)) {
        console.error("usage: assertion-ratchet.mjs <base> <head> | --since <base>");
        process.exit(2);
    }
    const { findings, declared } = weakenings(root, base, head);
    if (findings.length === 0) {
        console.error(`assertion-ratchet: no test file got weaker`);
        process.exit(0);
    }
    console.error(`assertion-ratchet: ${findings.length} test file${findings.length === 1 ? "" : "s"} got weaker:`);
    for (const line of findings) {
        console.error(`  ${line}`);
    }
    if (declared) {
        console.error(`assertion-ratchet: declared by a \`test!:\` subject or a \`Test-Note:\` trailer in the range, so it passes`);
        process.exit(0);
    }
    console.error(
        `assertion-ratchet: no commit in the range declares it. Restore the assertions (update the expected value, not the matcher), ` +
            `or, if the weakening is the point, say so: a \`test!:\` subject or a \`Test-Note:\` trailer on one of the commits.`,
    );
    process.exit(1);
}
