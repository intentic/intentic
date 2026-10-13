import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "@intentic/sandbox-contract";
import { fileRunOutStore, poolName, runOutOf, type RunOut } from "./run-outs.js";

/* Codex's five-hour window reopened at 16:37, and four Sol subagents started at 17:05 spent it by 18:15; the window
   before it had gone in twenty-one minutes under five (2026-10-13). What is kept of each is what a parent fanning out
   reads next: how far into its window the allowance ran out, and under how many agents on which models. */

const H = 3_600;
const REOPENS = 1_791_929_158;
const fiveHour = (utilization: number, resetsAt: number): UsageWindow => ({ kind: "five_hour", utilization, gates: "all", resetsAt });
const weekly = (utilization: number): UsageWindow => ({ kind: "seven_day", utilization, gates: "all", resetsAt: REOPENS + 4 * 24 * H });

describe("a run-out as it is recorded", () => {
    it("names the window that reopens when the refusal said, and when that window had opened", () => {
        const runOut = runOutOf({
            at: (REOPENS - 5 * H + 70 * 60) * 1000,
            model: "gpt-6.1-sol",
            resetsAt: REOPENS - 1,
            readings: [{ windows: [fiveHour(97, REOPENS), weekly(31)], measuredAt: 0 }],
            running: [{ model: "gpt-6.1-sol" }, { model: "gpt-6.1-sol" }, { model: "gpt-6.1-sol" }, { model: "gpt-6-sol" }],
        });
        expect(runOut).toStrictEqual({
            at: (REOPENS - 5 * H + 70 * 60) * 1000,
            pool: "five-hour",
            openedAt: (REOPENS - 1 - 5 * H) * 1000,
            reopensAt: REOPENS - 1,
            models: { "gpt-6.1-sol": 3, "gpt-6-sol": 1 },
        });
    });

    it("falls to the fullest window the model spends when the refusal named no reopening", () => {
        const runOut = runOutOf({ at: 1, readings: [{ windows: [weekly(40), fiveHour(100, REOPENS)], measuredAt: 0 }], running: [] });
        expect(runOut).toMatchObject({ pool: "five-hour", reopensAt: REOPENS, openedAt: (REOPENS - 5 * H) * 1000, models: {} });
    });

    it("says no window where no reading names one", () => {
        expect(runOutOf({ at: 1, model: "composer-2.5", readings: [], running: [{}] })).toStrictEqual({ at: 1, models: { "composer-2.5": 1 } });
    });

    it("names a pool by its label, else by its length", () => {
        expect(poolName({ kind: "seven_day", label: "Weekly" })).toBe("Weekly");
        expect(poolName({ kind: "five_hour" })).toBe("five-hour");
        expect(poolName({ kind: "seven_day" })).toBe("weekly");
        expect(poolName({ kind: "entitlement:gpt-6-astra" })).toBeUndefined();
    });
});

describe("the run-outs on file", () => {
    const store = () => fileRunOutStore(join(mkdtempSync(join(tmpdir(), "run-outs-")), "run-outs.json"));
    const first: RunOut = { at: Date.now() - 60_000, reopensAt: REOPENS, models: { "gpt-6.1-sol": 4 } };

    it("keeps the first refusal of a window over the burst that follows it", async () => {
        const runOuts = store();
        await runOuts.record("codex", first);
        await runOuts.record("codex", { at: Date.now(), reopensAt: REOPENS + 60, models: { "gpt-6.1-sol": 1 } });
        expect((await runOuts.read())["codex"]).toStrictEqual(first);
    });

    it("takes the next window's in its place", async () => {
        const runOuts = store();
        await runOuts.record("codex", first);
        const next: RunOut = { at: Date.now(), reopensAt: REOPENS + 5 * H, models: { "gpt-6-sol": 2 } };
        await runOuts.record("codex", next);
        expect((await runOuts.read())["codex"]).toStrictEqual(next);
    });

    it("forgets one older than a week", async () => {
        const runOuts = store();
        await runOuts.record("codex", { ...first, at: Date.now() - 8 * 24 * H * 1000 });
        expect(await runOuts.read()).toStrictEqual({});
    });
});
