import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeBudgets, type Baseline, type Budget } from "./baseline.js";
import { BROWSER_BUDGETS, UNRECORDED_BROWSER_BUDGETS } from "./browser/browser-budgets.js";
import { SCENARIOS } from "./browser/scenarios.js";
import { INSTR_BUDGETS } from "./instr/instr-budgets.js";

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
        const budgets = [...BROWSER_BUDGETS, ...UNRECORDED_BROWSER_BUDGETS];
        expect(budgets.flatMap((budget) => budget.reads).filter((name) => !names.has(name))).toEqual([]);
    });

    // A budget waits outside the recorded list only until its scenario is recorded; then it joins it, and the headroom
    // check above, in the same change.
    it("keeps a budget out of the recorded list only while its scenario has no recording", () => {
        const { scenarios } = recorded("browser");
        const recordedNow = UNRECORDED_BROWSER_BUDGETS.filter((budget) => budget.reads.some((scenario) => scenarios[scenario] !== undefined));
        expect(recordedNow.map((budget) => budget.name)).toEqual([]);
    });
});
