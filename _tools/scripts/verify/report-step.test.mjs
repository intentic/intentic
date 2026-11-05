import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findingsIn, fromRoot } from "./report-step.mjs";

const script = fileURLToPath(new URL("report-step.mjs", import.meta.url));
const ESC = String.fromCharCode(27);

test("findingsIn reads rustfmt's diffs, rustc's arrows and the checks' own lines", () => {
    const output = [
        "Diff in /w/_sandbox/ic/src/main.rs:12:",
        `${ESC}[31m-fn main(){${ESC}[m`,
        "Diff in /w/old/lib.rs at line 3:",
        "warning: unneeded `return` statement",
        "  --> src/main.rs:2:18",
        "   |",
        "warning: `ic` (bin \"ic\") generated 1 warning",
        "error[E0308]: mismatched types",
        " --> src/a.rs:7:9",
        "_tools/x.mjs:4: a finding a check printed",
    ].join("\n");
    assert.deepEqual(findingsIn(output), [
        { file: "/w/_sandbox/ic/src/main.rs", line: 12, message: "not formatted as rustfmt would (cargo fmt writes it; ci.yml's autofix job pushes it on main)" },
        { file: "/w/old/lib.rs", line: 3, message: "not formatted as rustfmt would (cargo fmt writes it; ci.yml's autofix job pushes it on main)" },
        { file: "src/main.rs", line: 2, col: 18, message: "warning: unneeded `return` statement" },
        { file: "src/a.rs", line: 7, col: 9, message: "error: mismatched types" },
        { file: "_tools/x.mjs", line: 4, message: "a finding a check printed" },
    ]);
});

test("fromRoot finds a cargo path from the run directory or the manifest's", () => {
    const root = mkdtempSync(join(tmpdir(), "report-step-"));
    try {
        mkdirSync(join(root, "crates/ic/src"), { recursive: true });
        writeFileSync(join(root, "crates/ic/src/main.rs"), "");
        assert.equal(fromRoot(root, join(root, "crates/ic"), "src/main.rs"), "crates/ic/src/main.rs");
        assert.equal(fromRoot(root, root, "src/main.rs", [join(root, "crates/ic")]), "crates/ic/src/main.rs");
        assert.equal(fromRoot(root, root, join(root, "crates/ic/src/main.rs")), "crates/ic/src/main.rs");
        assert.equal(fromRoot(root, root, "/elsewhere/x.rs"), undefined);
        assert.equal(fromRoot(root, root, "src/missing.rs"), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a failing command is reported and exits 0, or keeps its status when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-step-run-"));
    try {
        const summary = join(dir, "summary.md");
        writeFileSync(summary, "");
        const failing = [process.execPath, "-e", "console.log('Diff in ' + process.argv[1] + ':3:'); process.exit(1)", script];
        const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary };
        const reported = spawnSync(process.execPath, [script, "--title", "fmt probe", "--", ...failing], { encoding: "utf8", env });
        assert.equal(reported.status, 0);
        assert.match(reported.stdout, /::warning file=_tools\/scripts\/verify\/report-step\.mjs,line=3,title=fmt probe::not formatted/);
        assert.match(readFileSync(summary, "utf8"), /#### fmt probe\nexit 1, reported and not failed/);
        const kept = spawnSync(process.execPath, [script, "--title", "kept", "--keep-status", "--", ...failing], { encoding: "utf8", env });
        assert.equal(kept.status, 1);
        assert.equal(spawnSync(process.execPath, [script, "--", "true"], { encoding: "utf8" }).status, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
