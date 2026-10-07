// Pins the stall watch's three endings (bun-progress.mjs): a run that reported every file and sits idle is ended with
// the verdict its output gave, a run that printed its summary and stayed is ended the same way, and a run silent past the
// limit is ended as a failure naming what never reported. Anything short of those keeps waiting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { test } from "node:test";
import { cpuTicks, createProgress, decide, observe, unreported, watchProgress } from "./bun-progress.mjs";

const T0 = 1_000_000;
const MIN = 60_000;

const fed = (expected, lines) => {
    const progress = createProgress(expected, T0);
    for (const line of lines) {
        observe(progress, line, T0);
    }
    return progress;
};

test("reads file headings, failures and the summary out of bun's output, colours and all", () => {
    const progress = fed(
        ["./src/a.test.ts", "src/b.integration.test.ts"],
        [
            "##[group]src/a.test.ts:",
            "(pass) one [0.1ms]",
            "\u001b[31m(fail)\u001b[0m two [0.2ms]",
            "src/b.integration.test.ts:",
            "(pass) three",
            "Ran 3 tests across 2 files. [1.00s]",
        ],
    );
    assert.deepEqual([...progress.seen].sort(), ["src/a.test.ts", "src/b.integration.test.ts"]);
    assert.equal(progress.failures, 1);
    assert.equal(progress.summary, true);
    assert.deepEqual(unreported(progress), []);
});

test("a silence shorter than the per-test timeout is a test still running, whatever has reported", () => {
    const progress = fed(["a.test.ts"], ["##[group]a.test.ts:", "(pass) x"]);
    assert.equal(decide(progress, { now: T0 + 2 * MIN, timeoutMs: 2 * MIN, idle: true }), undefined);
});

test("every file reported, silent past the timeout and idle: ended, keeping a pass", () => {
    const progress = fed(["a.test.ts", "b.test.ts"], ["a.test.ts:", "(pass) x", "b.test.ts:", "(pass) y"]);
    const decision = decide(progress, { now: T0 + 3 * MIN, timeoutMs: 2 * MIN, idle: true });
    assert.equal(decision?.status, 0);
    assert.match(decision?.why ?? "", /all 2 files/u);
});

test("the same with a failure on record is ended as a failure", () => {
    const progress = fed(["a.test.ts"], ["a.test.ts:", "(fail) x"]);
    assert.equal(decide(progress, { now: T0 + 3 * MIN, timeoutMs: 2 * MIN, idle: true })?.status, 1);
});

test("a tree still burning CPU is not judged stuck at exit: it may be a test no timeout can stop", () => {
    const progress = fed(["a.test.ts"], ["a.test.ts:", "(pass) x"]);
    assert.equal(decide(progress, { now: T0 + 3 * MIN, timeoutMs: 2 * MIN, idle: false }), undefined);
});

test("a file that never reported keeps it waiting until the limit, which fails the run and names the file", () => {
    const progress = fed(["a.test.ts", "never.test.ts"], ["a.test.ts:", "(pass) x"]);
    assert.equal(decide(progress, { now: T0 + 5 * MIN, timeoutMs: 2 * MIN, idle: true }), undefined);
    const decision = decide(progress, { now: T0 + 10 * MIN, timeoutMs: 2 * MIN, idle: true });
    assert.equal(decision?.status, 1);
    assert.match(decision?.why ?? "", /never reported: never\.test\.ts/u);
});

test("a summary printed and no exit is ended with the summary's verdict", () => {
    const progress = fed(["a.test.ts", "b.test.ts"], ["a.test.ts:", "(pass) x", "Ran 1 tests across 2 files. [1s]"]);
    // b never headed (a file with no tests), and the tree is busy: the summary alone is enough.
    assert.equal(decide(progress, { now: T0 + 3 * MIN, timeoutMs: 2 * MIN, idle: false })?.status, 0);
});

test("the limit is three per-test timeouts when that is longer than ten minutes", () => {
    const progress = fed(["a.test.ts", "b.test.ts"], ["a.test.ts:"]);
    assert.equal(decide(progress, { now: T0 + 11 * MIN, timeoutMs: 5 * MIN, idle: true }), undefined);
    assert.equal(decide(progress, { now: T0 + 15 * MIN, timeoutMs: 5 * MIN, idle: true })?.status, 1);
});

test("CPU ticks are read off /proc for this process and nothing for one that does not exist", () => {
    if (process.platform !== "linux") {
        return;
    }
    assert.ok(cpuTicks([process.pid]) >= 0);
    assert.equal(cpuTicks([2 ** 30]), 0);
});

const sink = () => new Writable({ write: (_chunk, _encoding, done) => done() });

// A stand-in for bun: prints its files, then sits on a timer forever, idle, the way the hung leg did.
const STUCK = `console.log("##[group]a.test.ts:"); console.log("(pass) x"); console.error("b.test.ts:"); console.error("(pass) y"); setInterval(() => {}, 1000);`;

test("a real process that reported everything and hangs is killed, and the run keeps its pass", { skip: process.platform !== "linux" }, async () => {
    const child = spawn(process.execPath, ["-e", STUCK], { stdio: ["ignore", "pipe", "pipe"] });
    const said = [];
    const stop = watchProgress(child, {
        expected: ["a.test.ts", "b.test.ts"],
        timeoutMs: 100,
        padMs: 100,
        floorMs: 60_000,
        checkMs: 150,
        log: (text) => said.push(text),
        out: sink(),
        err: sink(),
    });
    const started = Date.now();
    await new Promise((resolve) => child.once("exit", resolve));
    const decision = stop();
    assert.equal(decision?.status, 0);
    assert.ok(Date.now() - started < 10_000);
    assert.match(said.join(""), /stuck on its way out/u);
});

test("a process that exits on its own is left alone and decides nothing", async () => {
    const child = spawn(process.execPath, ["-e", `console.log("a.test.ts:"); console.log("(fail) x");`], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = watchProgress(child, { expected: ["a.test.ts"], timeoutMs: 100, padMs: 100, checkMs: 50, out: sink(), err: sink() });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(stop(), undefined);
});
