import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { fileRunOutStore, modelRunOut, newestRunOut, poolName, poolRunOut, runOutOf, type RunOut } from "./run-outs.js";

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
            kind: "five_hour",
            openedAt: (REOPENS - 1 - 5 * H) * 1000,
            reopensAt: REOPENS - 1,
            models: { "gpt-6.1-sol": 3, "gpt-6-sol": 1 },
        });
    });

    it("falls to the fullest window the model spends when the refusal named no reopening", () => {
        const runOut = runOutOf({ at: 1, readings: [{ windows: [weekly(40), fiveHour(100, REOPENS)], measuredAt: 0 }], running: [] });
        expect(runOut).toMatchObject({ pool: "five-hour", kind: "five_hour", reopensAt: REOPENS, openedAt: (REOPENS - 5 * H) * 1000, models: {} });
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
        expect(newestRunOut(await runOuts.read(), "codex")).toStrictEqual(first);
    });

    it("takes the next window's in its place", async () => {
        const runOuts = store();
        await runOuts.record("codex", first);
        const next: RunOut = { at: Date.now(), reopensAt: REOPENS + 5 * H, models: { "gpt-6-sol": 2 } };
        await runOuts.record("codex", next);
        expect(newestRunOut(await runOuts.read(), "codex")).toStrictEqual(next);
    });

    it("forgets one older than a week", async () => {
        const runOuts = store();
        await runOuts.record("codex", { ...first, at: Date.now() - 8 * 24 * H * 1000 });
        expect(await runOuts.read()).toStrictEqual({});
    });
});

/* 2026-11-08: one conversation was refused on Google twice, Opus in its Claude and GPT pool ("Resets in 144h") and Gemini
   Flash in its Gemini pool ("Resets in 152h"). With one record per provider the second replaced the first, and the file
   kept only the Gemini pool's. Each pool keeps its own now, and a reader asks for the one its model spends. */
describe("one provider's pools on file", () => {
    const dir = () => mkdtempSync(join(tmpdir(), "run-outs-"));
    const NOW_S = Math.floor(Date.now() / 1000);
    const CLAUDE_POOL: UsageWindow = { kind: "google:models:claude", label: "Claude and GPT models", utilization: 100, gates: { models: ["claude", "gpt"] }, resetsAt: NOW_S + 144 * H };
    const GEMINI_POOL: UsageWindow = { kind: "google:models:gemini", label: "Gemini models", utilization: 100, gates: { models: ["gemini"] }, resetsAt: NOW_S + 152 * H };
    const READING: AccountUsage = { windows: [CLAUDE_POOL, GEMINI_POOL], measuredAt: Date.now() };
    const opus = runOutOf({ at: Date.now() - 60_000, model: "claude-opus-5-5", resetsAt: CLAUDE_POOL.resetsAt, readings: [READING], running: [{ model: "claude-opus-5-5" }] });
    const flash = runOutOf({ at: Date.now() - 30_000, model: "gemini-3-flash", resetsAt: GEMINI_POOL.resetsAt, readings: [READING], running: [{ model: "gemini-3-flash" }] });

    it("keeps each pool's run-out, however far apart they reopen", async () => {
        const runOuts = fileRunOutStore(join(dir(), "run-outs.json"));
        await runOuts.record("gemini", opus);
        await runOuts.record("gemini", flash);
        const onFile = await runOuts.read();
        expect(Object.keys(onFile).toSorted()).toEqual(["gemini:google:models:claude", "gemini:google:models:gemini"]);
        expect(poolRunOut(onFile, "gemini", CLAUDE_POOL)).toMatchObject({ pool: "Claude and GPT models", models: { "claude-opus-5-5": 1 } });
        expect(poolRunOut(onFile, "gemini", GEMINI_POOL)).toMatchObject({ pool: "Gemini models", models: { "gemini-3-flash": 1 } });
    });

    it("answers each model with the pool it spends, and the newest of any where no model is asked about", async () => {
        const runOuts = fileRunOutStore(join(dir(), "run-outs.json"));
        await runOuts.record("gemini", opus);
        await runOuts.record("gemini", flash);
        const onFile = await runOuts.read();
        expect(modelRunOut(onFile, "gemini", [READING], "claude-opus-5-5")).toStrictEqual(opus);
        expect(modelRunOut(onFile, "gemini", [READING], "gemini-3-flash")).toStrictEqual(flash);
        expect(modelRunOut(onFile, "gemini", [READING], undefined)).toStrictEqual(flash);
        // A model whose pool never ran out has no run-out to quote, not another pool's.
        expect(modelRunOut({ "gemini:google:models:gemini": flash }, "gemini", [READING], "claude-opus-5-5")).toBeUndefined();
    });

    it("quotes a plan's whole allowance for every model, where no reading named a pool", () => {
        const whole: RunOut = { at: Date.now(), models: { "composer-2.5": 2 } };
        expect(modelRunOut({ "cursor:*": whole }, "cursor", [], "composer-2.5")).toStrictEqual(whole);
    });

    it("reads a file written with one record per provider as that provider's record for the pool it names, and files it by pool on the next write", async () => {
        const path = join(dir(), "run-outs.json");
        const old: RunOut = { at: Date.now() - 120_000, pool: "Gemini models", reopensAt: GEMINI_POOL.resetsAt, models: {} };
        const codex: RunOut = { at: Date.now() - 120_000, pool: "five-hour", reopensAt: REOPENS, models: {} };
        writeFileSync(path, JSON.stringify({ gemini: old, codex }));
        const runOuts = fileRunOutStore(path);
        const onFile = await runOuts.read();
        expect(poolRunOut(onFile, "gemini", GEMINI_POOL)).toStrictEqual(old);
        expect(poolRunOut(onFile, "gemini", CLAUDE_POOL)).toBeUndefined();
        expect(modelRunOut(onFile, "codex", [], undefined)).toStrictEqual(codex);

        // The Gemini pool refused again in the same window: the first refusal stays, now under the pool's own key.
        await runOuts.record("gemini", flash);
        await runOuts.record("gemini", opus);
        // SAFETY: the store has just written this file whole, each record through RunOutSchema.
        const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, RunOut>;
        expect(Object.keys(stored).toSorted()).toEqual(["codex:five-hour", "gemini:google:models:claude", "gemini:google:models:gemini"]);
        expect(stored["gemini:google:models:gemini"]).toStrictEqual({ ...old, kind: "google:models:gemini" });
        expect(stored["gemini:google:models:claude"]).toStrictEqual(opus);
    });
});
