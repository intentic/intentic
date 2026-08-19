import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { briefForStep, type Handover, stepConversations } from "./workflow-brief.js";

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
    for (const one of design.steps) {
        const brief = briefForStep(one, [], "make the importer handle empty files");
        expect(brief, one.id).toContain("make the importer handle empty files");
        expect(brief, one.id).toContain("What this run was asked to do");
    }
});

// A run started from the workflows page has no composer behind it, and a heading over nothing would read as a
// request the user forgot to write.
test("a run with no request says nothing about one", () => {
    const design = workflow([step("only")]);
    const brief = briefForStep(design.steps[0]!, []);
    expect(brief).not.toContain("What this run was asked to do");
});

// The request leads, because it is what everything below it serves: a step that reads the handovers first has
// already been told what to think before being told what the job is.
test("the request comes before what the steps before concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    const brief = briefForStep(design.steps[1]!, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief.indexOf("What this run was asked to do")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

/* THE WORKFLOW ITSELF IS NEVER MENTIONED, and this asserts the absence because the sentence was here and was
 * exactly the wrapper the default exists to remove. A step used to open with its own title and "this is step 2
 * of 3 in the workflow **a workflow** — <the design's whole description>", which is the scheduler's bookkeeping:
 * the model cannot act on being second, and one told it is an arm of a comparison writes for the comparison.
 */
test("a step is never told which step of what it is", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    for (const one of design.steps) {
        const brief = briefForStep(one, [], "the ask");
        expect(brief, one.id).not.toContain("a workflow");
        expect(brief, one.id).not.toContain("step 2");
        expect(brief, one.id).not.toContain(`# ${one.title}`);
    }
});

/* A STEP WITH A JOB OF ITS OWN ENDS ON IT, under two words of label. Its words are the instruction and the
 * request is the context, so the request goes above and the step's own prompt is the last thing read — the
 * position an instruction has in any message somebody writes by hand. The label is there because without it a
 * block of instruction runs straight on from the section above and reads as more of that section; it is the
 * whole of the framing, which is what "no wrapper" meant.
 */
test("a declared prompt is the last thing the step reads", () => {
    const brief = briefForStep(step("only", { prompt: "merge the two branches" }), [], "the ask");
    expect(brief.endsWith("## Your task\n\nmerge the two branches")).toBe(true);
});

// Nothing above it ⇒ nothing to distinguish it from, and a heading over the only thing in a message is
// furniture — the same rule that hands an inheriting root the bare request.
test("a step with a prompt and nothing above it is that prompt alone", () => {
    expect(briefForStep(step("only", { prompt: "merge the two branches" }), [])).toBe("merge the two branches");
});

/* A ROOT THAT DECLARES NO PROMPT IS HANDED THE REQUEST AND NOTHING ELSE — the default, and `toBe` rather than a
 * list of `not.toContain`s because the property is "nothing", not "none of the things we thought of". Every
 * heading stands between the sentence the reader typed and the model that has to act on it, and the only way to
 * keep that true is to assert the whole string.
 */
test("a root with no prompt of its own is handed the request and nothing else", () => {
    const design = workflow([step("only", { prompt: undefined, goal: undefined })]);
    expect(briefForStep(design.steps[0]!, [], "make the importer handle empty files")).toBe("make the importer handle empty files");
});

/* An inheriting step that is NOT a root still gets its handovers, and this is the line between "no wrapper" and
 * "no context". A fan-in step handed only the request would re-derive what its predecessors already settled,
 * which is the disagreement the handover section exists to prevent — the framing is what is dropped, not the
 * facts.
 */
test("an inheriting step still receives what the steps before it concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"], prompt: undefined, goal: undefined })]);
    const brief = briefForStep(design.steps[1]!, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief).toContain("the ask");
    expect(brief).toContain("What the steps before you concluded");
    expect(brief).toContain("I did the first bit");
    // The request still leads: the job first, then what is already settled about it.
    expect(brief.indexOf("the ask")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

/* NOTHING IS SAID ABOUT THE WORKTREE, and this asserts the absence because the sentence was here and was wrong.
 *
 * A step does run isolated, and the step after it can read its pinned-base-to-branch diff — so telling it to
 * commit looked like closing a real hole. It was not one: the daemon commits the worktree onto that branch
 * itself at clean turn completion (agents/land.ts, in both `check` and `measure` modes). The paragraph
 * instructed the model to do something already done for it, and it was the largest single thing standing
 * between the reader's sentence and the model.
 */
test("nothing is added about the worktree — the daemon commits the branch itself", () => {
    const design = workflow([step("declared"), step("inheriting", { prompt: undefined, goal: undefined })]);
    for (const one of design.steps) {
        expect(briefForStep(one, [], "the ask").toLowerCase(), one.id).not.toContain("worktree");
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

/* WHERE THE PREDECESSOR'S WORK IS, in the three states the handover carries — the distinction that keeps a
 * reviewer from reading an empty diff and calling it a pass. `undefined` is the shared-tree case where the
 * question does not arise; a list is work that has been resolved; and the EMPTY list is the one that has to be
 * said out loud, because a reader told nothing assumes the ordinary case and goes looking for a diff.
 */
const after = (over: Partial<Handover>): string =>
    briefForStep(step("second", { needs: ["first"] }), [{ title: "first", document: undefined, report: "did some of it", ...over }]);

test("a resolved branch is handed over as a diff against the run's own starting commit", () => {
    const brief = after({ branches: [{ repo: "root", base: "abc123", branch: "agent/xyz" }] });
    expect(brief).toContain("git diff abc123...agent/xyz");
});

test("a step that committed nothing says so, instead of leaving the reader to find an empty diff", () => {
    const brief = after({ branches: [] });
    expect(brief).toContain("no committed changes");
    expect(brief).not.toContain("git diff");
});

// The shared-tree case: the work is simply in the tree the reader is standing in, and a paragraph about
// branches would send it looking for one that was never made.
test("a handover with no branch question says nothing about branches at all", () => {
    expect(after({})).not.toContain("git diff");
    expect(after({})).not.toContain("no committed changes");
});
