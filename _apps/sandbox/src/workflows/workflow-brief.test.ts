import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { briefForStep, stepConversations } from "./workflow-brief.js";

/* WHAT A STEP IS TOLD. The brief is the only thing standing between a graph of separate sessions and four
 * agents doing four unrelated jobs, and it is pure text assembly — so it is testable here, exactly, rather
 * than inferred from a run that costs money.
 */

const step = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    title: id,
    goal: `${id} is done`,
    prompt: `do ${id}`,
    needs: [],
    handoff: "fresh",
    output: { kind: "claim" },
    checks: [],
    context: "fresh",
    ...over,
});

const workflow = (steps: readonly WorkflowStep[]): Workflow => ({
    id: "wf",
    name: "a workflow",
    steps: [...steps],
    maxParallel: 2,
});

/* THE REQUEST REACHES EVERY STEP, and this is the assertion the composer's whole workflow pill rests on: the
 * user types one sentence, and a step four nodes down that never saw the composer still knows what the run is
 * for. A brief that carried it only to the roots would leave the reviewer judging work against a summary of a
 * summary, which is the failure the handover section already exists to prevent.
 */
test("the run's request is handed to every step, root or not", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    for (const [at, one] of design.steps.entries()) {
        const brief = briefForStep(design, one, at + 1, [], "make the importer handle empty files");
        expect(brief, one.id).toContain("make the importer handle empty files");
        expect(brief, one.id).toContain("What this run was asked to do");
    }
});

// A run started from the workflows page has no composer behind it, and a heading over nothing would read as a
// request the user forgot to write.
test("a run with no request says nothing about one", () => {
    const design = workflow([step("only")]);
    const brief = briefForStep(design, design.steps[0]!, 1, []);
    expect(brief).not.toContain("What this run was asked to do");
});

// The request leads, because it is what everything below it serves: a step that reads the handovers first has
// already been told what to think before being told what the job is.
test("the request comes before what the steps before concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    const brief = briefForStep(design, design.steps[1]!, 2, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief.indexOf("What this run was asked to do")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

/* A `continue` step takes its predecessor's conversation — the mechanism behind "same agent, same worktree,
 * next phase" — and every other step gets one of its own. Asserted here because the ids are also branch names
 * and directory names, so a change to this shape is a change to what a user sees in `git branch`.
 */
test("a continued step shares its predecessor's conversation and a fresh one does not", () => {
    const design = workflow([step("first"), step("carry", { needs: ["first"], handoff: "continue" }), step("apart", { needs: ["carry"] })]);
    const conversations = stepConversations("r1", design.steps);
    expect(conversations.get("carry")).toBe(conversations.get("first"));
    expect(conversations.get("apart")).toBe("wf-r1-apart");
});
