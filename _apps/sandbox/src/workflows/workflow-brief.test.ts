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

/* A STEP THAT DECLARES NO PROMPT IS HANDED THE REQUEST AND NOTHING ELSE — the default, and the assertion that
 * keeps it a default rather than a claim in a comment.
 *
 * Every heading here stands between the sentence the reader typed and the model that has to act on it, and a
 * model handed five sections about a workflow will spend some of its attention on the workflow. So the
 * inheriting step gets no title banner, no "step 2 of 3", and no heading over the request — a heading over the
 * only thing in the brief is furniture.
 */
test("a step with no prompt of its own is handed the request unwrapped", () => {
    const design = workflow([step("only", { prompt: undefined, goal: undefined })]);
    const brief = briefForStep(design, design.steps[0]!, 1, [], "make the importer handle empty files");
    expect(brief).toContain("make the importer handle empty files");
    expect(brief).not.toContain("What this run was asked to do");
    expect(brief).not.toContain("Your task");
    expect(brief).not.toContain("This is step 1 of");
    expect(brief).not.toContain("# only");
    // It still has to be told where it is standing — that is the one thing nothing else tells it.
    expect(brief).toContain("COMMIT AS YOU GO");
});

/* An inheriting step that is NOT a root still gets its handovers, and this is the line between "no wrapper" and
 * "no context". A fan-in step handed only the request would re-derive what its predecessors already settled,
 * which is the disagreement the handover section exists to prevent — the framing is what is dropped, not the
 * facts.
 */
test("an inheriting step still receives what the steps before it concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"], prompt: undefined, goal: undefined })]);
    const brief = briefForStep(design, design.steps[1]!, 2, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief).toContain("the ask");
    expect(brief).toContain("What the steps before you concluded");
    expect(brief).toContain("I did the first bit");
    // The request still leads: the job first, then what is already settled about it.
    expect(brief.indexOf("the ask")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

/* THE FACT NO SESSION IS TOLD ANYWHERE ELSE. Every workflow step runs in a worktree of its own and the
 * sandbox's system prompt never mentions isolation, so this line used to live in the template's own prose —
 * where a design that forgot it produced an attempt whose work never left the working tree, handing the step
 * downstream (which reads `git diff main...<branch>`) an empty diff and a truthful report that nothing was
 * done. It is on every step now, declared prompt or not.
 */
test("every step is told it is in its own worktree and must commit", () => {
    const design = workflow([step("declared"), step("inheriting", { prompt: undefined, goal: undefined })]);
    for (const [at, one] of design.steps.entries()) {
        expect(briefForStep(design, one, at + 1, [], "the ask"), one.id).toContain("git diff main...");
    }
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
