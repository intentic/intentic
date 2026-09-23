// Pins how a failed run becomes units, since a unit that reads differently in two checkouts charges a turn with main's red.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    againstBaseline,
    failedTasks,
    failureLines,
    judgeUnits,
    junitFailures,
    junitFile,
    logTail,
    rerunCommand,
    takeSummary,
    typeDiagnostics,
    unhandledErrors,
    unitsOf,
    verdictUnits,
} from "./failure-units.mjs";

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="2">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="4" failures="2">
    <testsuite name="outer" file="src/a.test.ts" line="2" tests="2" failures="1">
      <testcase name="passes" classname="outer" time="0.1" file="src/a.test.ts" line="3" assertions="1" />
      <testcase name="a &gt; b &quot;quoted&quot; > raw" classname="outer" time="0.1" file="src/a.test.ts" line="4" assertions="1">
        <failure type="AssertionError" message="Expected: 43&#10;Received: 42">AssertionError</failure>
      </testcase>
    </testsuite>
    <testcase name="skipped one" classname="" file="src/a.test.ts" line="6"><skipped /></testcase>
    <testcase name="top-level fails" classname="" time="0.1" file="src/a.test.ts" line="7" assertions="0">
      <failure type="Error" message="boom">Error: boom</failure>
    </testcase>
  </testsuite>
</testsuites>`;

const LOAD_LOG = `bun test v1.4.2

src/broken.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './gone.js' from '/srv/checkout/intentic/pkg/src/broken.test.ts' after 3021ms
-------------------------------

src/fine.test.ts:
 3 pass
`;

test("type diagnostics are read from tsgo's non-TTY lines and nothing else", () => {
    const log = "$ tsgo --noEmit\nsrc/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n  continuation\n[ELIFECYCLE] failed";
    assert.deepEqual(typeDiagnostics(log), [{ file: "src/a.ts", line: 12, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." }]);
});

test("a JUnit report yields its failing cases with the describe path, skipping passes and skips", () => {
    assert.deepEqual(junitFailures(JUNIT), [
        { file: "src/a.test.ts", name: 'outer > a > b "quoted" > raw' },
        { file: "src/a.test.ts", name: "top-level fails" },
    ]);
});

test("an unhandled error is charged to the file bun was printing when it happened", () => {
    const [found] = unhandledErrors(LOAD_LOG);
    assert.equal(found.file, "src/broken.test.ts");
    assert.match(found.message, /^error: Cannot find module/);
});

test("units read the same from two checkouts of one tree, and a task with no readable failure stands whole", () => {
    const units = (root) => {
        const junit = join(root, "junit");
        mkdirSync(join(root, "pkg/.turbo"), { recursive: true });
        mkdirSync(junit, { recursive: true });
        writeFileSync(join(root, "pkg/.turbo/turbo-test.log"), LOAD_LOG.replaceAll("/srv/checkout/intentic", root));
        writeFileSync(junitFile(junit, "@scope/pkg", "unit"), JUNIT);
        writeFileSync(join(root, "pkg/.turbo/turbo-typecheck.log"), "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n");
        const tasks = [
            { taskId: "@scope/pkg#test", name: "@scope/pkg", task: "test", directory: "pkg", logFile: "pkg/.turbo/turbo-test.log" },
            { taskId: "@scope/pkg#typecheck", name: "@scope/pkg", task: "typecheck", directory: "pkg", logFile: "pkg/.turbo/turbo-typecheck.log" },
            { taskId: "@scope/other#test", name: "@scope/other", task: "test", directory: "other", logFile: "other/.turbo/turbo-test.log" },
        ];
        return unitsOf(root, tasks, junit);
    };
    const first = mkdtempSync(join(tmpdir(), "units-a-"));
    const second = mkdtempSync(join(tmpdir(), "units-b-"));
    try {
        const expected = [
            '@scope/pkg#test pkg/src/a.test.ts › outer > a > b "quoted" > raw',
            "@scope/pkg#test pkg/src/a.test.ts › top-level fails",
            "@scope/pkg#test pkg/src/broken.test.ts › unhandled error: Cannot find module './gone.js' from 'pkg/src/broken.test.ts' after #ms",
            "@scope/pkg#typecheck pkg/src/a.ts: TS2304 Cannot find name 'x'.",
            "@scope/other#test",
        ];
        assert.deepEqual(units(first), expected);
        assert.deepEqual(units(second), expected);
    } finally {
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
    }
});

test("one more copy of a standing failure is new, and the standing copies are not", () => {
    const known = ["t a", "t a", "t b"];
    assert.deepEqual(judgeUnits(["t a", "t a", "t a", "t c"], known), { mine: ["t a", "t c"], standing: ["t a", "t a"] });
    assert.deepEqual(judgeUnits(["t b"], []), { mine: ["t b"], standing: [] });
});

test("a summary is the newest one written since the run began, and it is gone once read", () => {
    const root = mkdtempSync(join(tmpdir(), "summary-"));
    try {
        const runs = join(root, ".turbo/runs");
        mkdirSync(runs, { recursive: true });
        const summary = (name, at, exitCode) => {
            writeFileSync(join(runs, name), JSON.stringify({ tasks: [{ taskId: `p#${name}`, package: "p", task: "test", directory: "p", logFile: "l", execution: { exitCode } }] }));
            utimesSync(join(runs, name), at / 1000, at / 1000);
        };
        const now = Date.now();
        summary("old.json", now - 60_000, 1);
        summary("new.json", now, 1);
        summary("skipped.json", now - 1000, 0);
        const taken = takeSummary(root, now - 5000);
        assert.deepEqual(failedTasks(taken).map(({ taskId }) => taskId), ["p#new.json"]);
        assert.deepEqual(readdirSync(runs).sort(), ["old.json", "skipped.json"]);
        assert.equal(takeSummary(root, now + 60_000), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("against a red base a turn answers only for what main did not already fail, and a green base spares nothing", () => {
    const red = { status: "failed", failures: ["w#test a › x", "w#typecheck b: TS1 m"], failedTasks: ["w#test", "w#typecheck"], truncated: false };
    assert.deepEqual(againstBaseline(["w#test a › x", "w#test a › y"], red), { held: ["w#test a › y"], standing: ["w#test a › x"], unsure: [] });
    assert.deepEqual(againstBaseline(["w#test a › x"], { status: "passed" }), { held: ["w#test a › x"], standing: [], unsure: [] });
    assert.deepEqual(againstBaseline(["w#test a › x"], undefined), { held: ["w#test a › x"], standing: [], unsure: [] });
});

test("a unit in a task the base verdict cut short is reported, not held", () => {
    const cut = { status: "failed", failures: ["w#test a › x"], failedTasks: ["w#test", "v#test"], truncated: true };
    assert.deepEqual(againstBaseline(["v#test q › z", "u#test r › s"], cut), { held: ["u#test r › s"], standing: [], unsure: ["v#test q › z"] });
});

test("a verdict keeps a capped list and says when it cut one", () => {
    const units = Array.from({ length: 401 }, (_, index) => `t#test f › ${index}`);
    const kept = verdictUnits(units, [{ taskId: "t#test" }, { taskId: "t#test" }]);
    assert.equal(kept.failures.length, 400);
    assert.equal(kept.truncated, true);
    assert.deepEqual(kept.failedTasks, ["t#test"]);
});

test("a log tail keeps the last lines that say anything, escape codes dropped", () => {
    assert.deepEqual(logTail("start\n\u001b[31merror: boom\u001b[0m\n\n   \n  at x  \n", 2), ["error: boom", "  at x"]);
});

test("failure lines name every failing task's first failure before any task's second, and quote a whole task's log", () => {
    const root = mkdtempSync(join(tmpdir(), "failure-lines-"));
    try {
        mkdirSync(join(root, "other/.turbo"), { recursive: true });
        writeFileSync(join(root, "other/.turbo/turbo-test.log"), `$ bun test\nerror: ${root}/other/setup.ts failed to load\n`);
        const tasks = [{ taskId: "@s/other#test", name: "@s/other", task: "test", directory: "other", logFile: "other/.turbo/turbo-test.log" }];
        const units = ["@s/pkg#typecheck a.ts: TS1 one", "@s/pkg#typecheck b.ts: TS1 two", "@s/other#test", "@s/web#test c.test.ts › works"];
        assert.deepEqual(failureLines(root, units, tasks), [
            "@s/pkg#typecheck a.ts: TS1 one",
            "@s/other#test",
            "  $ bun test",
            "  error: other/setup.ts failed to load",
            "@s/web#test c.test.ts › works",
            "@s/pkg#typecheck b.ts: TS1 two",
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a re-run command names only the failing packages, and counts past eight rather than listing them", () => {
    const task = (name, kind) => ({ taskId: `${name}#${kind}`, name, task: kind });
    assert.equal(rerunCommand([task("@s/a", "typecheck"), task("@s/a", "test"), task("@s/b", "test")]), "pnpm turbo run test typecheck --only --filter @s/a --filter @s/b");
    const many = Array.from({ length: 10 }, (_, index) => task(`@s/p${index}`, "test"));
    assert.match(rerunCommand(many), /--filter @s\/p7 \(\+2 more\)$/);
});
