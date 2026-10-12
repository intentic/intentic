import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { CRASH_LOOP_RESTARTS, judgeProbation, type ProbationLook, probationStep, type ProbationStep, type ProbationVerdict, UPDATE_PROBATION } from "./update-probation.js";

// The update probation policy and its rule, held to golden/update-probation.json: the cases hand-written from ic's Rust
// (probation.rs), which builds every one of them too. A number or a reason that moves in one language and not the other
// fails here or there, naming the case.

interface JudgeCase {
    readonly name: string;
    readonly look: Partial<ProbationLook>;
    readonly swap: { readonly at: number; readonly reach: string | null };
    readonly now: number;
    readonly graceMs?: number;
    readonly verdict: ProbationVerdict;
}
interface StepCase {
    readonly name: string;
    readonly verdict: ProbationVerdict;
    readonly strikes: number;
    readonly over: boolean;
    readonly step: ProbationStep;
}

// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "update-probation.json"), "utf8")) as {
    readonly policy: Record<string, number>;
    readonly base: ProbationLook;
    readonly judge: JudgeCase[];
    readonly steps: StepCase[];
};

test("the policy numbers are the ones the golden records for ic, to the unit", () => {
    expect(Object.fromEntries(Object.entries(UPDATE_PROBATION))).toEqual(GOLDEN.policy);
    expect(GOLDEN.policy).toHaveProperty("crashLoopRestarts", CRASH_LOOP_RESTARTS);
});

test.each(GOLDEN.judge)("judges: $name", ({ look, swap, now, graceMs, verdict }) => {
    expect(judgeProbation({ ...GOLDEN.base, ...look }, swap, now, graceMs)).toEqual(verdict);
});

test.each(GOLDEN.steps)("steps: $name", ({ verdict, strikes, over, step }) => {
    expect(probationStep(verdict, strikes, over)).toEqual(step);
});
