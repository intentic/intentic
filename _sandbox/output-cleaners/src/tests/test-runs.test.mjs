import { describe, expect, it } from "bun:test";
import { parseTestRun } from "../test-runs.mjs";

// Each runner's output as it really prints it (cargo 1.9x and bun 1.4 captured in a sandbox, 2026-11-19; nextest, vitest,
// jest, pytest and go from their documented reporters), read back as tests.

const lines = (text) => text.split("\n");

const CARGO = `   Compiling ttc v0.1.0 (/tmp/tt-cargo)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 2.38s
     Running unittests src/lib.rs (target/debug/deps/ttc-08d0c4e0d165cdb7)

running 4 tests
test tests::slow ... ignored
test tests::adds ... ok
test tests::panics ... FAILED
test tests::bad_add ... FAILED

failures:

---- tests::panics stdout ----

thread 'tests::panics' (1458558) panicked at src/lib.rs:8:27:
boom 42
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

---- tests::bad_add stdout ----

thread 'tests::bad_add' (1458557) panicked at src/lib.rs:7:28:
assertion \`left == right\` failed
  left: 3
 right: 4


failures:
    tests::bad_add
    tests::panics

test result: FAILED. 1 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--lib\`
     Running tests/integ.rs (target/debug/deps/integ-d7ba48a63a38fea1)

running 2 tests
test integ_ok ... ok
test integ_bad ... FAILED

failures:

---- integ_bad stdout ----

thread 'integ_bad' panicked at 'sub was wrong', tests/integ.rs:2:26


failures:
    integ_bad

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

describe("cargo test", () => {
    it("files each test under its binary's crate, with each failure's panic message and place", () => {
        const run = parseTestRun(lines(CARGO));
        expect(run?.runners).toEqual(["cargo"]);
        expect(run?.counts).toEqual({ passed: 2, failed: 3, ignored: 1 });
        expect(run?.summarized).toBe(true);
        expect(run?.tests.filter((test) => test.outcome === "fail")).toEqual([
            { suite: "ttc", name: "tests::panics", outcome: "fail", line: "boom 42 (src/lib.rs:8:27)" },
            { suite: "ttc", name: "tests::bad_add", outcome: "fail", line: "assertion `left == right` failed (src/lib.rs:7:28)" },
            // The pre-1.73 panic format carries its message inline.
            { suite: "integ", name: "integ_bad", outcome: "fail", line: "sub was wrong (tests/integ.rs:2:26)" },
        ]);
        expect(run?.tests.find((test) => test.name === "tests::slow")?.outcome).toBe("ignored");
    });

    // Tests run in parallel interleave their panics with each other and with the runner's own lines. 2026-11-22, the
    // shinobi-society audit: this is the output that gave the first test the second's header as its reason and the
    // second `test result: FAILED. …` (an agent's `cargo test 2>&1 | grep -E '^test |panicked'`).
    const A = "game::tests::fleet::a_node_of_a_fleet_only_refuses_a_stored_world_this_build_cannot_take_on";
    const B = "game::tests::fleet::a_stored_world_this_build_cannot_take_on_starts_a_standalone_game_over_once";
    const failures = (text) => parseTestRun(lines(text))?.tests.filter((test) => test.outcome === "fail");

    it("gives a failure only the panic its own thread names, never a neighbour's header or the summary", () => {
        expect(
            failures(`test game::tests::fleet::a_fleet_of_one_is_a_standalone_game ... ok
test ${A} ... FAILED
test ${B} ... FAILED
thread '${A}' (2130228) panicked at crates/server/src/game/tests/fleet.rs:131:9:
thread '${B}' (2130229) panicked at crates/server/src/game/tests/fleet.rs:178:9:
test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 58 filtered out; finished in 0.00s`),
        ).toEqual([
            { name: A, outcome: "fail", line: "panicked at crates/server/src/game/tests/fleet.rs:131:9" },
            { name: B, outcome: "fail", line: "panicked at crates/server/src/game/tests/fleet.rs:178:9" },
        ]);
    });

    it("leaves the messages after back-to-back headers unclaimed, and keeps the message of a panic that printed alone", () => {
        // `--nocapture`: each header opens with a blank line; three panicked at once, then one alone after the others.
        const run = failures(`     Running unittests src/lib.rs (target/debug/deps/server-0123456789abcdef)

running 4 tests

thread 'fleet::a' (11) panicked at crates/server/src/fleet.rs:10:9:

thread 'fleet::b' (12) panicked at crates/server/src/fleet.rs:20:9:

thread 'fleet::c' (13) panicked at crates/server/src/fleet.rs:30:9:
the node refused
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
assertion \`left == right\` failed
the world was taken twice
test fleet::a ... FAILED
test fleet::b ... FAILED
test fleet::c ... FAILED

thread 'fleet::d' (14) panicked at crates/server/src/fleet.rs:40:9:
no free port
test fleet::d ... FAILED

failures:

failures:
    fleet::a
    fleet::b
    fleet::c
    fleet::d

test result: FAILED. 0 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s`);
        expect(run?.map((test) => test.line)).toEqual([
            "panicked at crates/server/src/fleet.rs:10:9",
            "panicked at crates/server/src/fleet.rs:20:9",
            "panicked at crates/server/src/fleet.rs:30:9",
            "no free port (crates/server/src/fleet.rs:40:9)",
        ]);
    });

    it("reads a section only up to a neighbour's panic, takes a spawned thread's panic as the test's own, and keeps same-named tests of two crates apart", () => {
        const run = failures(`     Running unittests src/lib.rs (target/debug/deps/engine-0123456789abcdef)

running 3 tests
test tests::empty ... FAILED
test tests::mixed ... FAILED
test tests::spawns ... FAILED

failures:

---- tests::empty stdout ----
---- tests::mixed stdout ----

thread 'tests::empty' (21) panicked at src/lib.rs:5:9:

---- tests::spawns stdout ----

thread 'tokio-runtime-worker' (23) panicked at src/net.rs:9:5:
port 4000 is taken

failures:
    tests::empty
    tests::mixed
    tests::spawns

test result: FAILED. 0 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/render.rs (target/debug/deps/render-0123456789abcdef)

running 1 test
test tests::spawns ... FAILED

failures:

---- tests::spawns stdout ----
the frame was empty

failures:
    tests::spawns

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`);
        expect(run?.map((test) => [test.suite, test.name, test.line])).toEqual([
            // Its own thread's panic, found in another test's section: the place is sure, the message is not there.
            ["engine", "tests::empty", "panicked at src/lib.rs:5:9"],
            // Its section holds only a neighbour's panic: no reason rather than the wrong one.
            ["engine", "tests::mixed", undefined],
            ["engine", "tests::spawns", "port 4000 is taken (src/net.rs:9:5)"],
            ["render", "tests::spawns", "the frame was empty"],
        ]);
    });

    it("still names the failures a grep left, with no summary to count from", () => {
        const run = parseTestRun(["test tests::bad_add ... FAILED", "test tests::panics ... FAILED"]);
        expect(run?.summarized).toBe(false);
        expect(run?.counts).toEqual({ passed: 0, failed: 2, ignored: 0 });
        expect(run?.tests.map((test) => test.suite)).toEqual([undefined, undefined]);
    });
});

describe("cargo nextest", () => {
    const NEXTEST = `    Starting 4 tests across 2 binaries (1 test skipped)
        PASS [   0.003s] ttc tests::adds
        FAIL [   0.004s] ttc tests::bad_add
──── STDERR:             ttc tests::bad_add
thread 'tests::bad_add' panicked at src/lib.rs:7:28:
assertion \`left == right\` failed
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

     SIGSEGV [   0.010s] my-crate::integ integ_crash
        PASS [   0.002s] my-crate::bin/tool parses
────────────
     Summary [   0.020s] 4 tests run: 2 passed, 2 failed, 1 skipped
        FAIL [   0.004s] ttc tests::bad_add
     SIGSEGV [   0.010s] my-crate::integ integ_crash
error: test run failed`;

    it("names the same suites libtest does, and reads each test once though the summary repeats the failures", () => {
        const run = parseTestRun(lines(NEXTEST));
        expect(run?.runners).toEqual(["nextest"]);
        expect(run?.counts).toEqual({ passed: 2, failed: 2, ignored: 1 });
        expect(run?.tests).toEqual([
            { suite: "ttc", name: "tests::adds", outcome: "pass" },
            { suite: "ttc", name: "tests::bad_add", outcome: "fail", line: "assertion `left == right` failed (src/lib.rs:7:28)" },
            { suite: "integ", name: "integ_crash", outcome: "fail", line: "sigsegv" },
            { suite: "tool", name: "parses", outcome: "pass" },
        ]);
    });
});

describe("bun test", () => {
    it("reads the piped form: each test under its file, and the error printed before each failure", () => {
        const run = parseTestRun(
            lines(`bun test v1.4.3 (c6da4a4d3)

a.test.ts:
(pass) suite > passes [0.01ms]
4 |   it("fails", () => { expect(1).toBe(2); });
                                    ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/tt-bun/a.test.ts:4:33)
(fail) suite > fails [1.46ms]
(skip) suite > skipped
(fail) suite > slow [5001.00ms]
  ^ this test timed out after 5000ms.

b.test.ts:
(pass) b passes [0.02ms]

 2 pass
 1 skip
 2 fail
 3 expect() calls
Ran 5 tests across 2 files. [92.00ms]`),
        );
        expect(run?.counts).toEqual({ passed: 2, failed: 2, ignored: 1 });
        expect(run?.tests).toEqual([
            { file: "a.test.ts", name: "suite > passes", outcome: "pass" },
            { file: "a.test.ts", name: "suite > fails", outcome: "fail", line: "error: expect(received).toBe(expected)" },
            { file: "a.test.ts", name: "suite > skipped", outcome: "ignored" },
            { file: "a.test.ts", name: "suite > slow", outcome: "fail", line: "timed out after 5000ms" },
            { file: "b.test.ts", name: "b passes", outcome: "pass" },
        ]);
    });

    it("reads a terminal's symbols, and an agent run that prints no passes, with bun's closing recap", () => {
        const run = parseTestRun(
            lines(`src/x.test.ts:
error: boom here
✗ top fails [0.23ms]
» skipped one

1 tests failed:
✗ top fails [0.23ms]

 0 pass
 1 skip
 1 fail
Ran 2 tests across 1 file. [94.00ms]`),
        );
        expect(run?.tests).toEqual([
            { file: "src/x.test.ts", name: "top fails", outcome: "fail", line: "error: boom here" },
            { file: "src/x.test.ts", name: "skipped one", outcome: "ignored" },
        ]);
        expect(run?.counts).toEqual({ passed: 0, failed: 1, ignored: 1 });
    });
});

describe("the best-effort runners", () => {
    it("vitest: each FAIL of its failed-tests section with the line under it, and its Tests counts", () => {
        const run = parseTestRun(
            lines(` ✓ src/a.test.ts (3 tests) 5ms
 ❯ src/b.test.ts (2 tests | 1 failed) 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/b.test.ts > suite > test b
AssertionError: expected 1 to be 2
 ❯ src/b.test.ts:5:13

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)`),
        );
        expect(run?.counts).toEqual({ passed: 4, failed: 1, ignored: 0 });
        expect(run?.tests).toEqual([{ file: "src/b.test.ts", name: "suite > test b", outcome: "fail", line: "AssertionError: expected 1 to be 2" }]);
    });

    it("jest: each ● failure under its FAIL file, and its Tests: counts", () => {
        const run = parseTestRun(
            lines(`FAIL src/b.test.js
  suite
    ✕ test b (3 ms)
  ● suite › test b

    expect(received).toBe(expected) // Object.is equality

Tests:       1 failed, 1 passed, 2 total`),
        );
        expect(run?.counts).toEqual({ passed: 1, failed: 1, ignored: 0 });
        expect(run?.tests).toEqual([{ file: "src/b.test.js", name: "suite > test b", outcome: "fail", line: "expect(received).toBe(expected) // Object.is equality" }]);
    });

    it("pytest: the short summary's FAILED lines and the closing counts", () => {
        const run = parseTestRun(
            lines(`tests/test_x.py::test_ok PASSED
tests/test_x.py::test_foo FAILED
=========================== short test summary info ============================
FAILED tests/test_x.py::test_foo - AssertionError: assert 1 == 2
==================== 1 failed, 1 passed, 1 skipped in 0.12s ====================`),
        );
        expect(run?.counts).toEqual({ passed: 1, failed: 1, ignored: 1 });
        expect(run?.tests).toEqual([
            { name: "tests/test_x.py::test_ok", outcome: "pass" },
            { name: "tests/test_x.py::test_foo", outcome: "fail", line: "AssertionError: assert 1 == 2" },
        ]);
    });

    it("go test: each --- FAIL under the package line that follows it, with the line it logged", () => {
        const run = parseTestRun(
            lines(`--- FAIL: TestFoo (0.00s)
    foo_test.go:10: expected 1, got 2
--- PASS: TestBar (0.00s)
FAIL
FAIL	example.com/pkg	0.003s
ok  	example.com/other	0.002s`),
        );
        expect(run?.tests).toEqual([
            { name: "TestFoo", outcome: "fail", line: "foo_test.go:10: expected 1, got 2", suite: "example.com/pkg" },
            { name: "TestBar", outcome: "pass", suite: "example.com/pkg" },
        ]);
    });

    it("answers nothing for output no runner printed", () => {
        expect(parseTestRun(lines("hello\nworld\nall good"))).toBeUndefined();
    });
});
