import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStart, followOutput, matchShown, outputPattern, readOutputOn } from "./output-lines.js";

// A job's output read on from a mark, as `wait` reads it for a pattern and for a timeout's progress: real files in a real
// capture dir, written the way a running command writes them, a piece at a time.

let dir = "";
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intentic-run-job-lines-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const print = (text: string): void => appendFileSync(join(dir, "out"), text);

describe("reading a job's output on from a mark", () => {
    it("counts and keeps complete lines only, and the next read starts on the line still being written", () => {
        print("one\ntwo\nthr");
        const first = readOutputOn(dir, captureStart(dir));
        expect([first.lines, first.bytes, first.last.map((line) => [line.number, line.text]), first.unfinished]).toEqual([
            2,
            11,
            [
                [1, "one"],
                [2, "two"],
            ],
            "thr",
        ]);
        print("ee\nfour\n");
        const second = readOutputOn(dir, first.mark);
        expect([second.lines, second.last.map((line) => [line.number, line.text])]).toEqual([
            2,
            [
                [3, "three"],
                [4, "four"],
            ],
        ]);
        expect(readOutputOn(dir, second.mark)).toMatchObject({ lines: 0, bytes: 0 });
    });

    it("reads the unfinished last line too once the command has exited", () => {
        print("built\nexit without a newline");
        expect(readOutputOn(dir, captureStart(dir), { final: true }).last.map((line) => line.text)).toEqual(["built", "exit without a newline"]);
    });

    it("stops at the first line a pattern matches, past that line, with the lines around it", () => {
        print("Compiling a\nCompiling b\nerror[E0425]: cannot find value\n  --> src/main.rs:3:5\nCompiling c\nerror: aborting\n");
        const read = readOutputOn(dir, captureStart(dir), { until: /^error/u });
        expect(read.matched === undefined ? undefined : matchShown(read.matched)).toEqual({
            line: "error[E0425]: cannot find value",
            lineNumber: 3,
            context: "  1: Compiling a\n  2: Compiling b\n> 3: error[E0425]: cannot find value\n  4:   --> src/main.rs:3:5\n  5: Compiling c\n  6: error: aborting",
        });
        // Read on from the match, the next one is found, not the same one again.
        expect(readOutputOn(dir, read.mark, { until: /^error/u }).matched?.line).toEqual({ number: 6, text: "error: aborting" });
    });

    it("matches what was on screen: colours removed, a progress bar's redraws folded to its last frame", () => {
        print("\u001b[32mPASS\u001b[0m src/a.test.ts\rRUNS 3/3\r\u001b[1mDone in 4.2s\u001b[0m\n");
        expect(readOutputOn(dir, captureStart(dir), { until: /^Done in/u }).matched?.line.text).toBe("Done in 4.2s");
    });

    it("reads a file rewritten shorter than the mark from its start", () => {
        print("a long first run of the log\nand more\n");
        const mark = readOutputOn(dir, captureStart(dir)).mark;
        writeFileSync(join(dir, "out"), "fresh\n");
        expect(readOutputOn(dir, mark).last.map((line) => line.text)).toEqual(["fresh"]);
    });

    it("past its cap, reads the newest lines and counts the rest as skipped bytes", () => {
        print(`${"x".repeat(50)}\n`.repeat(10));
        const read = readOutputOn(dir, captureStart(dir), { cap: 120 });
        expect([read.bytes, read.skipped > 0, read.last.at(-1)?.text]).toEqual([510, true, "x".repeat(50)]);
        expect(read.mark.offset).toBe(510);
    });

    it("reads nothing, and throws nothing, from a capture that is not there", () => {
        expect(readOutputOn(join(dir, "gone"), captureStart(join(dir, "gone")))).toMatchObject({ lines: 0, bytes: 0, last: [] });
    });
});

describe("a pattern for a wait", () => {
    it("is JavaScript's syntax, case-sensitive unless it starts with (?i)", () => {
        expect(outputPattern("done in|FAILED")).toEqual(/done in|FAILED/);
        expect(outputPattern("(?i)listening on")).toEqual(/listening on/i);
    });

    it("says why a pattern that is not one, or matches every line, is refused", () => {
        expect(outputPattern("error(")).toMatchObject({ error: expect.stringContaining("not a regular expression") });
        expect(outputPattern("(?i)")).toMatchObject({ error: expect.stringContaining("every line") });
    });
});

describe("following a job's output for a pattern", () => {
    it("answers nothing until the line comes, then the match, and stays on it", async () => {
        const follow = followOutput(dir, undefined, /listening on :(\d+)/u, join(dir, "no-proc"));
        print("starting\n");
        expect(await follow.look(false)).toBeUndefined();
        print("listening on :5173");
        // Not a line until it ends, unless the command has exited.
        expect(await follow.look(false)).toBeUndefined();
        print("\n");
        expect((await follow.look(false))?.line).toEqual({ number: 2, text: "listening on :5173" });
        expect(follow.mark()).toMatchObject({ offset: "starting\nlistening on :5173\n".length, lines: 2 });
    });
});
