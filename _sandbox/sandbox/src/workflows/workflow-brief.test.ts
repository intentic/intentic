import type { Workflow, WorkflowStep } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { briefForStep, type Handover, stepConversations } from "./workflow-brief.js";

// The brief is the only thing standing between a graph of separate sessions and agents doing unrelated jobs; pure text
// assembly, tested directly rather than inferred from a run.

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

test("the run's request is handed to every step, root or not", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    for (const one of design.steps) {
        const brief = briefForStep(one, [], "make the importer handle empty files");
        expect(brief, one.id).toContain("make the importer handle empty files");
        expect(brief, one.id).toContain("What this run was asked to do");
    }
});

// A run started from the workflows page has no composer behind it, unlike every other entry point.
test("a run with no request says nothing about one", () => {
    const design = workflow([step("only")]);
    const brief = briefForStep(design.steps[0]!, []);
    expect(brief).not.toContain("What this run was asked to do");
});

test("the request comes before what the steps before concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    const brief = briefForStep(design.steps[1]!, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief.indexOf("What this run was asked to do")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

test("a step is never told which step of what it is", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"] })]);
    for (const one of design.steps) {
        const brief = briefForStep(one, [], "the ask");
        expect(brief, one.id).not.toContain("a workflow");
        expect(brief, one.id).not.toContain("step 2");
        expect(brief, one.id).not.toContain(`# ${one.title}`);
    }
});

test("a declared prompt is the last thing the step reads", () => {
    const brief = briefForStep(step("only", { prompt: "merge the two branches" }), [], "the ask");
    expect(brief.endsWith("## Your task\n\nmerge the two branches")).toBe(true);
});

test("a step with a prompt and nothing above it is that prompt alone", () => {
    expect(briefForStep(step("only", { prompt: "merge the two branches" }), [])).toBe("merge the two branches");
});

// `toBe`, not a list of `not.toContain`s: the property is nothing at all, not merely none of the checked things.
test("a root with no prompt of its own is handed the request and nothing else", () => {
    const design = workflow([step("only", { prompt: undefined, goal: undefined })]);
    expect(briefForStep(design.steps[0]!, [], "make the importer handle empty files")).toBe("make the importer handle empty files");
});

test("an inheriting step still receives what the steps before it concluded", () => {
    const design = workflow([step("first"), step("last", { needs: ["first"], prompt: undefined, goal: undefined })]);
    const brief = briefForStep(design.steps[1]!, [{ title: "first", document: undefined, report: "I did the first bit" }], "the ask");
    expect(brief).toContain("the ask");
    expect(brief).toContain("What the steps before you concluded");
    expect(brief).toContain("I did the first bit");
    expect(brief.indexOf("the ask")).toBeLessThan(brief.indexOf("What the steps before you concluded"));
});

test("nothing is added about the worktree: the daemon commits the branch itself", () => {
    const design = workflow([step("declared"), step("inheriting", { prompt: undefined, goal: undefined })]);
    for (const one of design.steps) {
        expect(briefForStep(one, [], "the ask").toLowerCase(), one.id).not.toContain("worktree");
    }
});

// ids double as branch and directory names, so this shape is user-visible in `git branch`.
test("a continued step shares its predecessor's conversation and a fresh one does not", () => {
    const design = workflow([step("first"), step("carry", { needs: ["first"], handoff: "continue" }), step("apart", { needs: ["carry"] })]);
    const conversations = stepConversations("r1", design.steps);
    expect(conversations.get("carry")).toBe(conversations.get("first"));
    expect(conversations.get("apart")).toBe("wf-r1-apart");
});

// Three states a handover carries: undefined (shared tree, no diff question), a list (resolved work), and empty
// (nothing committed, said explicitly so a reader doesn't go looking).
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

test("a handover with no branch question says nothing about branches at all", () => {
    expect(after({})).not.toContain("git diff");
    expect(after({})).not.toContain("no committed changes");
});
