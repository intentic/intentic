// What a test run printed, read as tests: each test's outcome and, for a failure, the first line that says why.
// cargo test (libtest), cargo nextest and bun test are read closely; vitest, jest, pytest and go test by their usual
// reporters, best-effort. Parsers read the text, never the command, so `cd x && …`, `pnpm test` and a wrapper all work,
// and each answers nothing for output that is not its runner's. Node builtins only, like every module the filter loads.

// A failure's line, kept to what one line of a digest can carry.
const LINE_MAX = 200;
const clip = (text) => {
    const line = text.trim().replaceAll(/\s+/g, " ");
    return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

// A test as a parser files it, its `line` set only for a failure that said why; a run, its counts only once a summary
// gave them.
const testOf = (fields, line) => {
    const test = { ...fields };
    if (line !== undefined) {
        test.line = line;
    }
    return test;
};
const runOf = (runner, tests, counts) => {
    const run = { runner, tests };
    if (counts !== undefined) {
        run.counts = counts;
    }
    return run;
};
const plus = (counts, passed, failed, ignored) => ({
    passed: (counts?.passed ?? 0) + passed,
    failed: (counts?.failed ?? 0) + failed,
    ignored: (counts?.ignored ?? 0) + ignored,
});

// A test binary's suite, the same name whichever runner printed it: libtest's `deps/engine-1a2b…` and nextest's
// `engine` for a crate's unit tests, `render` for its `tests/render.rs`, `foo` for its `src/bin/foo.rs`.
const suiteOfBinary = (path) =>
    (path.split("/").at(-1) ?? path)
        .replace(/-[0-9a-f]{16}$/, "")
        .replaceAll("-", "_");
const suiteOfNextest = (binaryId) => (binaryId.split("::").at(-1) ?? binaryId).replace(/^bin\//, "").replaceAll("-", "_");

// `thread 'name' (1234) panicked at src/lib.rs:8:27:` with the message on the next line (Rust 1.73+), or
// `thread 'name' panicked at 'message', src/lib.rs:8:27` (older).
const PANIC = /^thread '([^']+)'(?: \(\d+\))? panicked at (.+)$/;
const OLD_PANIC = /^'(.*)', (\S+:\d+:\d+)$/;
const BACKTRACE_NOTE = /^note: run with `RUST_BACKTRACE/;

// A panic's message and where it was, from its header line and the lines after it.
const panicLine = (rest, after) => {
    const old = OLD_PANIC.exec(rest);
    if (old !== null) {
        return clip(`${old[1]} (${old[2]})`);
    }
    const message = after.find((line) => line.trim() !== "" && !BACKTRACE_NOTE.test(line));
    const where = rest.replace(/:$/, "");
    return clip(message === undefined ? `panicked at ${where}` : `${message} (${where})`);
};

// Every panic in the output by the thread it happened on, which libtest and nextest name after the test.
const panicsOf = (lines) => {
    const panics = new Map();
    lines.forEach((line, index) => {
        const panic = PANIC.exec(line);
        if (panic !== null && !panics.has(panic[1])) {
            panics.set(panic[1], panicLine(panic[2], lines.slice(index + 1, index + 4)));
        }
    });
    return panics;
};

const LIBTEST_RUNNING = /^\s*Running (?:unittests )?\S+ \((.+)\)\s*$/;
const LIBTEST_DOC = /^\s*Doc-tests (\S+)\s*$/;
const LIBTEST_TEST = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, .*)?)$/;
const LIBTEST_SECTION = /^---- (.+?) (?:stdout|stderr) ----$/;
const LIBTEST_RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/;
const LIBTEST_OUTCOME = { ok: "pass", FAILED: "fail" };

// The first telling line under a failed test's `---- name stdout ----`: its panic, or what it printed first.
const sectionLines = (lines) => {
    const first = new Map();
    let name;
    for (const [index, line] of lines.entries()) {
        const section = LIBTEST_SECTION.exec(line);
        if (section !== null) {
            name = section[1];
            continue;
        }
        if (name === undefined || first.has(name) || line.trim() === "" || BACKTRACE_NOTE.test(line)) {
            name = line.startsWith("failures:") || line.startsWith("test result:") ? undefined : name;
            continue;
        }
        const panic = PANIC.exec(line);
        first.set(name, panic === null ? clip(line) : panicLine(panic[2], lines.slice(index + 1, index + 4)));
    }
    return first;
};

/** cargo test: `test name ... ok|FAILED|ignored` under each binary's `Running` line, and its `test result:` counts. */
const parseLibtest = (lines) => {
    if (!lines.some((line) => LIBTEST_RESULT.test(line) || LIBTEST_TEST.test(line))) {
        return undefined;
    }
    const sections = sectionLines(lines);
    const panics = panicsOf(lines);
    const tests = [];
    let counts;
    let suite;
    for (const line of lines) {
        const running = LIBTEST_RUNNING.exec(line) ?? LIBTEST_DOC.exec(line);
        suite = running === null ? suite : suiteOfBinary(running[1]);
        const test = LIBTEST_TEST.exec(line);
        if (test !== null) {
            const outcome = LIBTEST_OUTCOME[test[2]] ?? "ignored";
            const why = outcome === "fail" ? (sections.get(test[1]) ?? panics.get(test[1])) : undefined;
            tests.push(testOf({ suite, name: test[1], outcome }, why));
        }
        const result = LIBTEST_RESULT.exec(line);
        counts = result === null ? counts : plus(counts, Number(result[1]), Number(result[2]), Number(result[3]));
    }
    return runOf("cargo", tests, counts);
};

// `        FAIL [   0.004s] engine tests::bad_add`, with an optional `(3/40)` counter before the binary.
const NEXTEST_STATUS =
    /^\s*(PASS|FAIL|SKIP|LEAK|LEAK-FAIL|FLAKY(?: \d+\/\d+)?|TIMEOUT|ABORT|SIG[A-Z]+|TRY \d+ [A-Z-]+)\s+\[\s*[\d.]+m?s\]\s+(?:\(\s*\d+\/\s*\d+\)\s+)?(\S+)\s+(.+?)\s*$/;
const NEXTEST_SUMMARY = /^\s*Summary \[\s*[\d.]+m?s\]\s+\d+ tests? run: (.+)$/;
const nextestOutcome = (status) => {
    if (status.startsWith("TRY ")) {
        return undefined; // A retry's attempt, not the test's outcome: its final line follows.
    }
    if (status === "PASS" || status === "LEAK" || status.startsWith("FLAKY")) {
        return "pass";
    }
    return status === "SKIP" ? "ignored" : "fail";
};
const countWords = (text) => Object.fromEntries([...text.matchAll(/(\d+) ([a-z][a-z ]*?)(?=,|$|\s\()/g)].map((match) => [match[2].trim(), Number(match[1])]));

/** cargo nextest: one status line per test, the summary's counts, and each failure's panic by its thread. */
const parseNextest = (lines) => {
    if (!lines.some((line) => NEXTEST_SUMMARY.test(line) || /^\s*Starting \d+ tests? across/.test(line))) {
        return undefined;
    }
    const panics = panicsOf(lines);
    const tests = lines.flatMap((line) => {
        const status = NEXTEST_STATUS.exec(line);
        const outcome = status === null ? undefined : nextestOutcome(status[1]);
        if (outcome === undefined) {
            return [];
        }
        const why = outcome === "fail" ? (panics.get(status[3]) ?? clip(status[1].toLowerCase())) : undefined;
        return [testOf({ suite: suiteOfNextest(status[2]), name: status[3], outcome }, why)];
    });
    const summary = lines.map((line) => NEXTEST_SUMMARY.exec(line)?.[1]).findLast((found) => found !== undefined);
    const words = countWords(summary ?? "");
    const counts = summary === undefined ? undefined : plus(undefined, words["passed"] ?? 0, (words["failed"] ?? 0) + (words["timed out"] ?? 0) + (words["leaky failed"] ?? 0), words["skipped"] ?? 0);
    return runOf("nextest", tests, counts);
};

// bun test: `path/to/a.test.ts:` heads each file; a test is `(pass) name [1.2ms]` piped and `✓ name` on a terminal. A
// failure's `error: …` comes BEFORE its `(fail)` line.
const BUN_FILE = /^(\S.*\.(?:[cm]?[jt]sx?)):$/;
const BUN_TEST = /^(?:\((pass|fail|skip|todo)\)|([✓✗»✎]))\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/;
const BUN_SYMBOL = { "✓": "pass", "✗": "fail", "»": "skip", "✎": "todo" };
const BUN_COUNT = /^\s*(\d+) (pass|fail|skip|todo)\s*$/;
const BUN_RAN = /^Ran \d+ tests? across \d+ files?\./;
// Bun repeats the failures at the end under `N tests failed:`: what follows it names no test anew.
const BUN_RECAP = /^\s*\d+ tests? failed:\s*$/;
const BUN_ERROR = /^(?:error|Error|\w*Error): \S/;
const BUN_TIMEOUT = /^\s*\^ this test timed out after (\d+)ms/;
const BUN_OUTCOME = { pass: "pass", fail: "fail", skip: "ignored", todo: "ignored" };

// Why a bun test failed: the error printed before it, or the timeout its next line names.
const bunWhy = (outcome, error, next = "") => {
    const timeout = BUN_TIMEOUT.exec(next);
    return outcome !== "fail" ? undefined : (error ?? (timeout === null ? undefined : `timed out after ${timeout[1]}ms`));
};
const bunCounts = (counts, line) => {
    const count = BUN_COUNT.exec(line);
    if (count === null) {
        return counts;
    }
    const value = Number(count[1]);
    return plus(counts, count[2] === "pass" ? value : 0, count[2] === "fail" ? value : 0, count[2] === "pass" || count[2] === "fail" ? 0 : value);
};

/** bun test: each test under its file, the error printed before each failure, and the closing counts. */
const parseBun = (lines) => {
    if (!lines.some((line) => BUN_RAN.test(line) || line.startsWith('(fail) ') || /^bun test v\d/.test(line))) {
        return undefined;
    }
    const recap = lines.findIndex((line) => BUN_RECAP.test(line));
    const tests = [];
    let file;
    let error;
    for (const [index, line] of (recap === -1 ? lines : lines.slice(0, recap)).entries()) {
        file = BUN_FILE.exec(line)?.[1] ?? file;
        error = BUN_FILE.test(line) ? undefined : (error ?? (BUN_ERROR.test(line) ? clip(line) : undefined));
        const test = BUN_TEST.exec(line);
        if (test !== null) {
            const outcome = BUN_OUTCOME[test[1] ?? BUN_SYMBOL[test[2]]];
            tests.push(testOf({ file, name: test[3], outcome }, bunWhy(outcome, error, lines[index + 1])));
            error = undefined;
        }
    }
    return runOf("bun", tests, lines.reduce(bunCounts, undefined));
};

// The first non-blank line after `index`, as a failure's reason.
const nextLine = (lines, index) => {
    const found = lines.slice(index + 1, index + 8).find((line) => line.trim() !== "");
    return found === undefined ? undefined : clip(found);
};


// vitest's `Tests  1 failed | 4 passed (5)` and jest's `Tests:       1 failed, 1 passed, 2 total`.
const VITEST_TESTS = /^\s*Tests\s{2,}(.+)$/;
const JEST_TESTS = /^Tests:\s+(.+)$/;
const countsOfWords = (words) => ({
    passed: words["passed"] ?? 0,
    failed: words["failed"] ?? 0,
    ignored: (words["skipped"] ?? 0) + (words["todo"] ?? 0),
});

/** vitest: each ` FAIL  file > suite > name` of its failed-tests section, and the `Tests` counts. */
const parseVitest = (lines) => {
    const summary = lines.find((line) => VITEST_TESTS.test(line) && /\b(?:passed|failed)\b/.test(line));
    if (summary === undefined || !lines.some((line) => /^\s*Test Files\s{2,}/.test(line))) {
        return undefined;
    }
    const tests = lines.flatMap((line, index) => {
        const fail = /^\s*FAIL\s+(\S+) > (.+?)\s*$/.exec(line);
        return fail === null ? [] : [testOf({ file: fail[1], name: fail[2], outcome: "fail" }, nextLine(lines, index))];
    });
    const words = countWords(VITEST_TESTS.exec(summary)?.[1].replaceAll("|", ",") ?? "");
    return { runner: "vitest", tests, counts: countsOfWords(words) };
};

/** jest: each `● suite › name` under its `FAIL file`, and the `Tests:` counts. */
const parseJest = (lines) => {
    const summary = lines.find((line) => JEST_TESTS.test(line));
    if (summary === undefined) {
        return undefined;
    }
    const tests = [];
    let file;
    for (const [index, line] of lines.entries()) {
        file = /^(?:PASS|FAIL)\s+(\S+)/.exec(line)?.[1] ?? file;
        const fail = /^\s+● (.+?)\s*$/.exec(line);
        if (fail !== null && fail[1] !== "Test suite failed to run") {
            tests.push(testOf({ file, name: fail[1].replaceAll(" › ", " > "), outcome: "fail" }, nextLine(lines, index)));
        }
    }
    return { runner: "jest", tests, counts: countsOfWords(countWords(JEST_TESTS.exec(summary)?.[1] ?? "")) };
};

const PYTEST_SUMMARY = /^=+ (.*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/;
const PYTEST_SHORT = /^(FAILED|ERROR) (\S+::\S+|\S+\.py)(?: - (.*))?$/;
const PYTEST_VERBOSE = /^(\S+::\S+) (PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b/;
const PYTEST_OUTCOME = { PASSED: "pass", XPASS: "pass", FAILED: "fail", ERROR: "fail", SKIPPED: "ignored", XFAIL: "ignored" };

/** pytest: the short summary's `FAILED node - message`, `-v`'s per-test lines, and the closing `= … in 1.2s =` counts. */
const parsePytest = (lines) => {
    const summary = lines.find((line) => PYTEST_SUMMARY.test(line));
    if (summary === undefined) {
        return undefined;
    }
    const tests = lines.flatMap((line) => {
        const short = PYTEST_SHORT.exec(line);
        if (short !== null) {
            return [testOf({ name: short[2], outcome: "fail" }, short[3] === undefined ? undefined : clip(short[3]))];
        }
        const verbose = PYTEST_VERBOSE.exec(line);
        return verbose === null ? [] : [{ name: verbose[1], outcome: PYTEST_OUTCOME[verbose[2]] }];
    });
    const words = countWords(PYTEST_SUMMARY.exec(summary)?.[1] ?? "");
    const counts = { passed: words["passed"] ?? 0, failed: (words["failed"] ?? 0) + (words["error"] ?? 0) + (words["errors"] ?? 0), ignored: words["skipped"] ?? 0 };
    return { runner: "pytest", tests, counts };
};

const GO_RESULT = /^\s*--- (FAIL|PASS|SKIP): (\S+) \(/;
const GO_PACKAGE = /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\))/;
const GO_OUTCOME = { PASS: "pass", FAIL: "fail", SKIP: "ignored" };

/** go test: `--- FAIL: TestX` and the line it logged, filed under the `ok`/`FAIL` package line that follows. */
const parseGo = (lines) => {
    if (!lines.some((line) => GO_PACKAGE.test(line) || GO_RESULT.test(line))) {
        return undefined;
    }
    const tests = [];
    let pending = [];
    for (const [index, line] of lines.entries()) {
        const result = GO_RESULT.exec(line);
        if (result !== null) {
            const outcome = GO_OUTCOME[result[1]];
            pending.push(testOf({ name: result[2], outcome }, outcome === "fail" ? nextLine(lines, index) : undefined));
        }
        const done = GO_PACKAGE.exec(line);
        if (done !== null) {
            tests.push(...pending.map((test) => ({ ...test, suite: done[2] })));
            pending = [];
        }
    }
    return { runner: "go", tests: [...tests, ...pending] };
};

const PARSERS = [parseNextest, parseLibtest, parseBun, parseVitest, parseJest, parsePytest, parseGo];

// Each test once: a runner that repeats its failures at the end (bun's recap, nextest's summary, pytest's short summary)
// is read at the first, with the first line any of its mentions gave.
const uniqueTests = (tests) => {
    const byKey = new Map();
    for (const test of tests) {
        const key = `${test.suite ?? ""}\n${test.file ?? ""}\n${test.name}`;
        const seen = byKey.get(key);
        byKey.set(key, seen === undefined ? test : testOf(seen, seen.line ?? test.line));
    }
    return [...byKey.values()];
};

const tally = (tests) => ({
    passed: tests.filter((test) => test.outcome === "pass").length,
    failed: tests.filter((test) => test.outcome === "fail").length,
    ignored: tests.filter((test) => test.outcome === "ignored").length,
});

/**
 * Every runner's tests in the output, once each, and the counts its summaries gave (or the tests' own tally where none
 * did). Undefined when no runner recognised anything. nextest is read before libtest: its captured output repeats
 * libtest's lines, and they are its own tests again.
 */
export const parseTestRun = (lines) => {
    const runs = [];
    for (const parse of PARSERS) {
        const run = parse(lines);
        if (run !== undefined && (run.tests.length > 0 || run.counts !== undefined) && !(parse === parseLibtest && runs.some((found) => found.runner === "nextest"))) {
            runs.push(run);
        }
    }
    if (runs.length === 0) {
        return undefined;
    }
    const tests = uniqueTests(runs.flatMap((run) => run.tests));
    const own = tally(tests);
    const summed = runs.reduce(
        (sum, run) => {
            const counts = run.counts ?? tally(run.tests);
            return { passed: sum.passed + counts.passed, failed: sum.failed + counts.failed, ignored: sum.ignored + counts.ignored };
        },
        { passed: 0, failed: 0, ignored: 0 },
    );
    // A summary never counts fewer failures than the run shows by name (a grep can drop the summary line, never a test).
    const counts = { passed: Math.max(summed.passed, own.passed), failed: Math.max(summed.failed, own.failed), ignored: Math.max(summed.ignored, own.ignored) };
    return {
        runners: runs.map((run) => run.runner),
        tests,
        counts,
        summarized: runs.every((run) => run.counts !== undefined),
    };
};
