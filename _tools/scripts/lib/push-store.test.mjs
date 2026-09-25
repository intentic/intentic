// Pins the one store a push and a land check leave in the git common dir: reports and tree verdicts side by side, each
// kind kept to its own count, and the verdicts' old file still read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { legacyVerdictPath, readStore, REPORTS_KEPT, VERDICTS_KEPT, writeStore } from "./push-store.mjs";
import { readVerdicts, writeVerdict } from "./tree-verdict.mjs";
import { readReports, writeReport } from "../verify/push-report.mjs";

const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "push-store-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
};

test("reports and verdicts share one file, each kept to its own count, newest first", () => {
    const root = repo();
    try {
        for (let n = 1; n <= VERDICTS_KEPT + 2; n += 1) {
            assert.equal(writeVerdict(root, `tree-${n}`, "passed", "verify"), true);
        }
        for (let n = 1; n <= REPORTS_KEPT + 2; n += 1) {
            assert.equal(writeReport(root, { version: 1, id: `r${n}`, at: n, kind: "recheck", recheck: [] }).ok, true);
        }
        assert.deepEqual(
            readReports(root).map(({ id }) => id),
            Array.from({ length: REPORTS_KEPT }, (_, index) => `r${REPORTS_KEPT + 2 - index}`),
        );
        const verdicts = readVerdicts(root);
        assert.equal(verdicts.length, VERDICTS_KEPT);
        assert.deepEqual([verdicts.at(0)?.tree, verdicts.at(-1)?.tree], [`tree-${VERDICTS_KEPT + 2}`, "tree-3"]);
        assert.equal(readStore(root).length, VERDICTS_KEPT + REPORTS_KEPT);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a verdict replaces the older one about the same tree and suite, and no other", () => {
    const root = repo();
    try {
        writeVerdict(root, "t", "failed", "push");
        writeVerdict(root, "t", "passed", "verify");
        writeVerdict(root, "t", "passed", "push");
        assert.deepEqual(
            readVerdicts(root).map(({ status, suite }) => `${suite}:${status}`),
            ["push:passed", "verify:passed"],
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the verdicts' old file is still read, and never written", () => {
    const root = repo();
    try {
        writeFileSync(legacyVerdictPath(root), JSON.stringify([{ tree: "old", status: "passed", suite: "verify", at: 1 }]));
        writeStore(root, { version: 1, kind: "verdict", tree: "new", status: "failed", suite: "push", at: 2 });
        assert.deepEqual(
            readVerdicts(root).map(({ tree }) => tree),
            ["new", "old"],
        );
        assert.deepEqual(
            readStore(root).map(({ tree }) => tree),
            ["new"],
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
