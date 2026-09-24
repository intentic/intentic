import { decide, failing, judge, table, updated, type Baseline } from "./baseline.js";

const baseline: Baseline = { host: { node: "v24" }, scenarios: { walk: { instructions: 1000, layouts: 4 } } };
const exact = (): number => 0;

describe("judge", () => {
    it("calls an identical count same and a move inside tolerance within", () => {
        const rows = judge(baseline, { walk: { instructions: 1004, layouts: 4 } }, (metric) => (metric === "instructions" ? 0.005 : 0), true);
        expect(rows.map((row) => [row.metric, row.verdict])).toEqual([
            ["instructions", "within"],
            ["layouts", "same"],
        ]);
        expect(failing(rows)).toEqual([]);
    });

    it("fails a count that moved past tolerance in either direction", () => {
        const rows = judge(baseline, { walk: { instructions: 1100, layouts: 3 } }, exact, true);
        expect(rows.map((row) => row.verdict)).toEqual(["regressed", "improved"]);
        expect(failing(rows)).toHaveLength(2);
    });

    it("names a metric or scenario the baseline has never seen, and one that stopped being measured", () => {
        const rows = judge(baseline, { walk: { instructions: 1000, layouts: 4, mutations: 2 }, fresh: { layouts: 1 } }, exact, true);
        expect(rows.filter((row) => row.verdict === "new").map((row) => `${row.scenario}.${row.metric}`)).toEqual([
            "fresh.layouts",
            "walk.mutations",
        ]);
        expect(judge(baseline, {}, exact, true).map((row) => row.verdict)).toEqual(["gone", "gone"]);
    });

    it("leaves a scenario that was filtered out of an incomplete run unjudged", () => {
        expect(judge(baseline, {}, exact, false)).toEqual([]);
    });

    it("reads a rise from zero as an unbounded regression", () => {
        const rows = judge({ host: {}, scenarios: { idle: { renders: 0 } } }, { idle: { renders: 3 } }, () => 10, true);
        expect(rows[0]?.verdict).toBe("regressed");
    });
});

describe("updated", () => {
    it("keeps the scenarios a filtered run did not measure", () => {
        const next = updated(baseline, { other: { layouts: 2 } }, { node: "v25" }, false);
        expect(Object.keys(next.scenarios)).toEqual(["other", "walk"]);
        expect(next.host).toEqual({ node: "v25" });
    });

    it("drops the scenarios a complete run no longer has", () => {
        expect(Object.keys(updated(baseline, { other: { layouts: 2 } }, {}, true).scenarios)).toEqual(["other"]);
    });
});

describe("decide", () => {
    const run = {
        path: "baselines/x.json",
        host: { node: "v24", cpu: "a" },
        tolerance: exact,
        complete: true,
        binding: ["node"],
        rerecord: "perf --update",
    };

    it("refuses to judge counts taken under a different runtime", () => {
        const decision = decide(baseline, { ...run, host: { node: "v25" }, measured: baseline.scenarios, update: false });
        expect(decision.ok).toBe(false);
        expect(decision.text).toContain("node: v24 → v25");
    });

    it("passes a matching run on a different cpu and says the host differs", () => {
        const decision = decide({ ...baseline, host: { node: "v24", cpu: "b" } }, { ...run, measured: baseline.scenarios, update: false });
        expect(decision.ok).toBe(true);
        expect(decision.text).toContain("cpu: b → a");
        expect(decision.record).toBeUndefined();
    });

    it("fails when there is no baseline yet and says how to record one", () => {
        const decision = decide({ host: {}, scenarios: {} }, { ...run, measured: baseline.scenarios, update: false });
        expect(decision.ok).toBe(false);
        expect(decision.text).toContain("no baseline at baselines/x.json; record one: perf --update");
    });

    it("re-records on update, and the next run matches the record", () => {
        const measured = { walk: { instructions: 2000, layouts: 4 } };
        const recorded = decide(baseline, { ...run, measured, update: true });
        expect(recorded.record).toEqual({ host: run.host, scenarios: { walk: { instructions: 2000, layouts: 4 } } });
        expect(decide(recorded.record!, { ...run, measured, update: false }).ok).toBe(true);
    });

    it("tells an improvement apart from a regression in its advice", () => {
        const decision = decide(baseline, { ...run, host: { node: "v24" }, measured: { walk: { instructions: 900, layouts: 4 } }, update: false });
        expect(decision.ok).toBe(false);
        expect(decision.text).toContain("cheaper than recorded: lock it in: perf --update");
    });
});

describe("table", () => {
    it("right-aligns counts and hides exact matches when quiet", () => {
        const rows = judge(baseline, { walk: { instructions: 1000, layouts: 5 } }, exact, true);
        expect(table(rows, true).split("\n")).toEqual([
            "scenario  metric   baseline  measured    delta  verdict",
            "walk      layouts         4         5  +25.00%  regressed",
        ]);
    });
});
