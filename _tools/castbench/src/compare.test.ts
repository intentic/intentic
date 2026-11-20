import { readFileSync } from "node:fs";
import { type Budget, type BudgetInput, type BudgetsInput, changeOf, compareTable, judge, limitOf, metricOf, parseBudgets, renderTable, verdictTable } from "./compare.js";
import type { RunFile, RunResult } from "./results.js";

// The comparison a run is read through: which budget judges which run, with what limit, and the table it prints.

const empty = { n: 0, p50: null, p99: null, mean: null, max: null };

const runOf = (overrides: Partial<RunResult> & Pick<RunResult, "workload" | "link">): RunResult => ({
    pipeline: "legacy",
    seconds: 12,
    picture: { width: 1280, height: 880 },
    encoderCores: 0.21,
    xvfbCores: 0.02,
    chromiumCores: 0.5,
    framesPerSec: 30,
    uniqueFps: { mean: 29.5, min: 28, p10: 28 },
    mbps: 1.4,
    latencyMs: { n: 300, p50: 45, p99: 80, mean: 47, max: 90 },
    displayMs: empty,
    pipelineMs: empty,
    stalls: 0,
    maxGapMs: 40,
    keyMs: empty,
    keyInputMs: empty,
    pasteMs: empty,
    inputMissed: 0,
    markerErrors: 0,
    decodeErrors: 0,
    keyframes: 1,
    encoderStarts: 1,
    ...overrides,
});

const fileOf = (runs: readonly RunResult[]): RunFile => ({
    recordedAt: "2026-11-19T00:00:00.000Z",
    host: { cpu: "test", cores: 16, kernel: "6.18", chromium: "156", ffmpeg: "7.1" },
    load: { before: [1, 1, 1], after: [1, 1, 1] },
    settings: { seconds: 12, warmupSeconds: 3, queueMs: 200, size: "1280x880", stage: "daemon" },
    runs,
});

const budget = (overrides: Partial<BudgetInput> = {}): Budget =>
    parseBudgets({ budgets: [{ id: "b", claim: "c", workload: "anim", link: "direct", metric: "latencyMs.p50", max: 40, ...overrides }] })[0]!;

describe("metricOf", () => {
    it("reads a top-level number and a summary's field", () => {
        const run = runOf({ workload: "anim", link: "direct" });
        expect(metricOf(run, "encoderCores")).toBe(0.21);
        expect(metricOf(run, "latencyMs.p99")).toBe(80);
        expect(metricOf(run, "keyMs.p50")).toBeNull();
    });
});

describe("parseBudgets", () => {
    it("refuses a budget naming a metric castbench does not measure", () => {
        expect(() => parseBudgets({ budgets: [{ id: "x", claim: "c", workload: "anim", link: "direct", metric: "latency.p50", max: 1 }] })).toThrow(
            "budget x names no metric castbench measures: latency.p50",
        );
    });

    it("refuses a budget with both or neither of max and min", () => {
        expect(() => parseBudgets({ budgets: [{ id: "y", claim: "c", workload: "anim", link: "direct", metric: "stalls" }] })).toThrow(
            "budget y must set exactly one of max and min",
        );
    });

    it("reads the package's own budgets.json whole", () => {
        // SAFETY: the file is this package's own, and parseBudgets checks every field the judging reads.
        const file = JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8")) as BudgetsInput;
        expect(parseBudgets(file).map((entry) => entry.id)).toEqual([
            "idle-encoder",
            "scroll-encoder",
            "scroll-fps",
            "lan-latency-p50",
            "lan-latency-p99",
            "wan10-latency-p50",
            "wan5-fps",
            "wan5-stalls",
            "keystroke",
            "paste",
        ]);
    });
});

describe("judge", () => {
    it("passes a reading at the limit and fails one past it", () => {
        const at = judge([runOf({ workload: "anim", link: "direct", latencyMs: { ...empty, p50: 40 } })], [budget()]);
        const past = judge([runOf({ workload: "anim", link: "direct", latencyMs: { ...empty, p50: 40.1 } })], [budget()]);
        expect(at.map((verdict) => verdict.pass)).toEqual([true]);
        expect(past.map((verdict) => verdict.pass)).toEqual([false]);
    });

    it("reads a min budget as a floor", () => {
        const floor = parseBudgets({ budgets: [{ id: "f", claim: "c", workload: "anim", link: "direct", metric: "uniqueFps.mean", min: 57 }] })[0]!;
        expect(judge([runOf({ workload: "anim", link: "direct", uniqueFps: { mean: 57, min: 50, p10: 55 } })], [floor])[0]?.pass).toBe(true);
        expect(judge([runOf({ workload: "anim", link: "direct", uniqueFps: { mean: 56.9, min: 50, p10: 55 } })], [floor])[0]?.pass).toBe(false);
    });

    it("judges only the runs of its workload and link, and every link for *", () => {
        const runs = [
            runOf({ workload: "typing", link: "direct", keyMs: { ...empty, p50: 25 } }),
            runOf({ workload: "typing", link: "5mbit-60ms", keyMs: { ...empty, p50: 95 } }),
            runOf({ workload: "anim", link: "direct" }),
        ];
        const keystroke = budget({ workload: "typing", link: "*", metric: "keyMs.p50", max: 30, plusRtt: true });
        expect(judge(runs, [keystroke]).map((verdict) => [verdict.link, verdict.limit, verdict.pass])).toEqual([
            ["direct", 30, true],
            ["5mbit-60ms", 90, false],
        ]);
    });

    it("has no verdict, rather than a failure, for a run without the reading", () => {
        expect(judge([runOf({ workload: "anim", link: "direct", latencyMs: empty })], [budget()])[0]?.pass).toBeNull();
    });
});

describe("limitOf", () => {
    it("adds the link's round trip only when the budget says so", () => {
        expect(limitOf(budget({ max: 30, plusRtt: true }), "10mbit-40ms")).toBe(70);
        expect(limitOf(budget({ max: 30 }), "10mbit-40ms")).toBe(30);
    });
});

describe("changeOf", () => {
    it("is a signed rounded percentage, blank where it cannot be one", () => {
        expect(changeOf(0.11, 0.21)).toBe("-48%");
        expect(changeOf(60, 30)).toBe("+100%");
        expect(changeOf(0, 0)).toBe("0%");
        expect(changeOf(0.1, 0)).toBe("");
        expect(changeOf(null, 3)).toBe("");
    });
});

describe("the tables", () => {
    it("pads columns to their widest cell", () => {
        expect(renderTable(["a", "b", "c", "num"], [["xx", "y", "z", "1"], ["x", "yy", "zz", "100"]])).toBe(
            ["a   b   c   num", "--  --  --  ---", "xx  y   z     1", "x   yy  zz  100"].join("\n"),
        );
    });

    it("compares a run with the baseline's run of the same workload and link, whatever its pipeline", () => {
        const baseline = fileOf([runOf({ workload: "still", link: "direct", encoderCores: 0.21, framesPerSec: 30, mbps: 0.04 })]);
        const current = fileOf([runOf({ pipeline: "castd", workload: "still", link: "direct", encoderCores: 0, framesPerSec: 0, mbps: 0 })]);
        const lines = compareTable(current, baseline).split("\n");
        expect(lines[0]).toMatch(/^workload\s+link\s+metric\s+castd\s+baseline \(legacy\)\s+Δ$/u);
        expect(lines.slice(2)).toEqual([
            "still     direct  encoder cores             0               0.21  -100%",
            "still     direct  Xvfb cores             0.02               0.02     0%",
            "still     direct  frames/s on the wire      0                 30  -100%",
            "still     direct  Mbit/s                    0               0.04  -100%",
        ]);
    });

    it("prints each verdict with its limit and direction", () => {
        const verdicts = judge([runOf({ workload: "anim", link: "direct" })], [budget()]);
        expect(verdictTable(verdicts).split("\n").at(-1)).toBe("b       direct  legacy       45   ≤ 40     FAIL");
    });
});
