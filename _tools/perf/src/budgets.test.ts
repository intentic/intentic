import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeBudgets, type Baseline, type Budget } from "./baseline.js";
import { BROWSER_BUDGETS } from "./browser/budgets.js";
import { SCENARIOS } from "./browser/scenarios.js";
import { INSTR_BUDGETS } from "./instr/budgets.js";

const recorded = (name: string): Baseline => JSON.parse(readFileSync(join(import.meta.dir, "..", "baselines", `${name}.json`), "utf8")) as Baseline;

const tracks: readonly (readonly [string, readonly Budget[]])[] = [
    ["instr", INSTR_BUDGETS],
    ["browser", BROWSER_BUDGETS],
];

describe("the declared budgets", () => {
    it.each(tracks)("%s: each reads recorded scenarios and holds on the recording with headroom", (track, budgets) => {
        const { scenarios } = recorded(track);
        for (const budget of budgets) {
            expect(budget.reads.filter((scenario) => scenarios[scenario] === undefined)).toEqual([]);
        }
        // A budget within a tenth of today's reading fails on noise, which is the golden master this replaced.
        const near = judgeBudgets(budgets, scenarios).filter(({ value, budget }) => value === undefined || value > budget.max * 0.9);
        expect(near.map(({ budget, value }) => `${budget.name}: ${value}`)).toEqual([]);
    });

    it("reads browser scenarios that exist", () => {
        const names = new Set(SCENARIOS.map((scenario) => scenario.name));
        expect(BROWSER_BUDGETS.flatMap((budget) => budget.reads).filter((name) => !names.has(name))).toEqual([]);
    });
});
