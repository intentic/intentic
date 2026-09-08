import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type AgentEvent, type AgentTurn, LOOP_DIR, type Workflow, type WorkflowStep, workflowFaults } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import type { Services } from "../composition.js";
import { fileLoopsStore } from "../loops/loops-store.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";
import { abandonRun, openRun, resumeWorkflowExecution, runWorkflow, stopWorkflowRun, workflowRunning } from "./workflow-runner.js";

// Scheduler's graph behavior end to end: the seam between steps, not a step's own loop (tested elsewhere). The tree has
// no git, so `treeDigest` never changes and the stall detector is live: every step needs its own reason to stop.

const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        loops: fileLoopsStore(join(root, "loops.json")),
        workflows: fileWorkflowsStore(join(root, "workflows.json")),
        workflowRuns: fileWorkflowRunsStore(join(root, "workflow-runs.json")),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        agents: unstubbed<Services["agents"]>("agents", { sessionIdOf: () => undefined }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { conversationDir: () => root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { append: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

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

const workflow = (steps: readonly WorkflowStep[], over: Partial<Workflow> = {}): Workflow => ({
    id: "wf",
    name: "a workflow",
    steps: [...steps],
    maxParallel: 4,
    ...over,
});

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "workflows-"));
const REPOS = [{ repo: "root", base: "1111111111111111111111111111111111111111" }] as const;

// Writes the verdict a step's loop needs to converge on iteration 1; `claims` decides per step id whether it's done.
// Reads the step id from the conversation id, not the prompt, so a shared `continue` conversation shows as the same id.
const claiming = (root: string, prompts: string[], claims: (stepId: string) => boolean = () => true): TurnFn =>
    async function* turn(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        const conversationId = input.conversationId ?? "";
        const stepId = conversationId.split("-").slice(2).join("-");
        const n = /Iteration (\d+)/.exec(input.prompt)?.[1] ?? "1";
        await mkdir(join(root, LOOP_DIR, conversationId), { recursive: true });
        await writeFile(
            join(root, LOOP_DIR, conversationId, `iteration-${n}.json`),
            JSON.stringify({ done: claims(stepId), reason: `${stepId} says ${claims(stepId)}`, data: { note: stepId } }),
        );
        yield { kind: "delta", text: `${stepId} report` } as AgentEvent;
        yield { kind: "done" } as AgentEvent;
    };

test("steps run in dependency order and each is handed what the one before it produced", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("plan"), step("build", { needs: ["plan"] }), step("verify", { needs: ["build"] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    await runWorkflow(services, run, claiming(root, prompts));

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("done");
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["done", "done", "done"]);
    expect(prompts[1]).toContain("plan says true");
    expect(prompts[2]).toContain(`"note": "build"`);
    expect(prompts[1]).not.toContain(`git diff`);
    expect(prompts[0]).not.toContain("plan says true");
});

test("workflow loops pin the full model choice, shared base, spend ceiling, and held landing posture", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    let turn: AgentTurn | undefined;
    const design = workflow([
        step("only", {
            output: { kind: "none" },
            agent: "codex",
            harness: "claude-code",
            account: "codex-account-2",
            model: "gpt-5.6",
            actsAs: "release-reviewer",
            maxSpendUsd: 3.5,
        }),
    ]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    const capture: TurnFn = async function* (_services, input) {
        turn = input;
        yield { kind: "done" } as AgentEvent;
    };

    await runWorkflow(services, run, capture);

    expect(turn).toMatchObject({
        agent: "codex",
        harness: "claude-code",
        account: "codex-account-2",
        model: "gpt-5.6",
        actsAs: "release-reviewer",
        worktreeBase: REPOS,
        autoLand: false,
    });
    expect((await services.loops.get(run.steps[0]!.conversationId))?.maxSpendUsd).toBe(3.5);
});

test("a long unstructured response is handed on through a complete shared artifact", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("write", { output: { kind: "none" } }), step("read", { needs: ["write"], output: { kind: "none" } })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    const full = `BEGIN\n${"middle\n".repeat(2_000)}END`;
    let downstream = "";
    const turns: TurnFn = async function* (_services, input) {
        if (input.conversationId?.endsWith("-write") === true) {
            yield { kind: "delta", text: full } as AgentEvent;
        } else {
            downstream = input.prompt;
        }
        yield { kind: "done" } as AgentEvent;
    };

    await runWorkflow(services, run, turns);

    const settled = await services.workflowRuns.get(run.runId);
    const reportPath = settled?.steps[0]?.reportPath;
    expect(reportPath).toBe(`.intentic/records/artifacts/workflow-runs/${run.runId}/write.md`);
    expect(await readFile(join(root, reportPath ?? ""), "utf8")).toBe(full);
    expect(downstream).toContain(reportPath);
    expect(settled?.steps[0]?.report?.length).toBeLessThan(full.length);
});

// Asserted end to end through the step brief, loop brief and turn, since each layer could add its own heading.
// `toEqual`, not `not.toContain`s: the property is nothing at all, so any future addition to any layer fails this.
test("an ordinary step's turn prompt is the request, byte for byte", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("only", { prompt: undefined, goal: undefined, output: { kind: "none" }, checks: [] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1, "make the importer handle empty files"));
    const capture: TurnFn = async function* turn(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, capture);

    expect(prompts).toEqual(["make the importer handle empty files"]);
    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("done");
    expect(settled?.steps[0]?.iterations).toBe(1);
});

test("a step with a job of its own still gets told what the run is for", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([
        step("review", { prompt: "read the diff and say what is wrong", goal: undefined, output: { kind: "none" }, checks: [] }),
    ]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1, "make the importer handle empty files"));
    const capture: TurnFn = async function* turn(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, capture);

    expect(prompts[0]).toContain("read the diff and say what is wrong");
    expect(prompts[0]).toContain("make the importer handle empty files");
    expect(prompts[0]).not.toContain("Iteration 1 of");
    expect(prompts[0]).not.toContain("the output file");
});

test("a failed step skips everything downstream of it and leaves the branch beside it alone", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([
        step("root"),
        step("bad", { needs: ["root"] }),
        step("after-bad", { needs: ["bad"] }),
        step("sibling", { needs: ["root"] }),
    ]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    await runWorkflow(
        services,
        run,
        claiming(root, [], (id) => id !== "bad"),
    );

    const settled = await services.workflowRuns.get(run.runId);
    const states = new Map(settled?.steps.map((entry) => [entry.stepId, entry.state]));
    expect(states.get("bad")).toBe("failed");
    expect(states.get("after-bad")).toBe("skipped");
    expect(states.get("sibling")).toBe("done");
    expect(settled?.state).toBe("failed");
    expect(settled?.steps.find((entry) => entry.stepId === "after-bad")?.detail).toContain(`"bad"`);
});

test("a step whose model was refused fails the run instead of reporting a done step with nothing in it", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const refusal = "Your organization has disabled Claude subscription access for Claude Code";
    const design = workflow([step("attempt", { output: { kind: "none" } }), step("after", { needs: ["attempt"], output: { kind: "none" } })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    // eslint-disable-next-line require-yield
    await runWorkflow(services, run, async function* refused() {
        yield { kind: "error", message: refusal } as AgentEvent;
        yield { kind: "done" } as AgentEvent;
    });

    const settled = await services.workflowRuns.get(run.runId);
    const states = new Map(settled?.steps.map((entry) => [entry.stepId, entry.state]));
    expect(states.get("attempt")).toBe("failed");
    expect(states.get("after")).toBe("skipped");
    expect(settled?.state).toBe("failed");
    expect(settled?.steps.find((entry) => entry.stepId === "attempt")?.detail).toContain("Claude subscription");
});

test("a fan-in step waits for every branch and is handed all of them", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("left"), step("right"), step("merge", { needs: ["left", "right"] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    await runWorkflow(services, run, claiming(root, prompts));

    const merged = prompts.at(-1) ?? "";
    expect(merged).toContain("left says true");
    expect(merged).toContain("right says true");
    expect((await services.workflowRuns.get(run.runId))?.state).toBe("done");
});

test("maxParallel bounds how many steps are inside a turn at once", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    let inFlight = 0;
    let peak = 0;
    const counting: TurnFn = async function* turn(_services, input: AgentTurn) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const conversationId = input.conversationId ?? "";
        await mkdir(join(root, LOOP_DIR, conversationId), { recursive: true });
        await writeFile(join(root, LOOP_DIR, conversationId, `iteration-1.json`), JSON.stringify({ done: true, reason: "ok" }));
        inFlight -= 1;
        yield { kind: "done" } as AgentEvent;
    };
    const design = workflow([step("a"), step("b"), step("c"), step("d"), step("e")], { maxParallel: 2 });
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    await runWorkflow(services, run, counting);

    expect(peak).toBeLessThanOrEqual(2);
    expect((await services.workflowRuns.get(run.runId))?.state).toBe("done");
});

test("the sandbox-wide workflow limit bounds several fan-outs together", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    let active = 0;
    let peak = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const blocking: TurnFn = async function* () {
        active += 1;
        peak = Math.max(peak, active);
        await held;
        active -= 1;
        yield { kind: "done" } as AgentEvent;
    };
    const design = workflow([step("only", { output: { kind: "none" } })], { maxParallel: 8 });
    const runs = await Promise.all(Array.from({ length: 5 }, () => services.workflowRuns.start(openRun(design, REPOS, Date.now()))));
    const executions = runs.map((run) => runWorkflow(services, run, blocking));

    // Slots are sandbox-wide module state shared by every test in this file; releasing in `finally` stops a failed wait
    // from starving every later test of a slot.
    try {
        await vi.waitFor(() => expect(peak).toBe(4), SETTLES);
    } finally {
        release();
    }
    await Promise.all(executions);
    expect(peak).toBe(4);
    expect((await services.workflowRuns.list()).every((run) => run.state === "done")).toBe(true);
});

test("a `continue` step runs on its predecessor's conversation; a `fresh` one gets its own", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("first"), step("second", { needs: ["first"], handoff: "continue" }), step("third", { needs: ["first"] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    const conversations = new Map(run.steps.map((entry) => [entry.stepId, entry.conversationId]));

    expect(conversations.get("second")).toBe(conversations.get("first"));
    expect(conversations.get("third")).not.toBe(conversations.get("first"));
});

test("stopping a run stops the loop in flight and starts nothing further", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("slow"), step("never", { needs: ["slow"] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    // Never writes a verdict, so its loop would run to the scheduler's backstop; the stop is what ends it.
    const endless: TurnFn = async function* turn() {
        stopWorkflowRun(run.runId);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, endless);

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("stopped");
    expect(settled?.steps.find((entry) => entry.stepId === "slow")?.iterations).toBe(1);
    expect(settled?.steps.find((entry) => entry.stepId === "never")?.state).toBe("stopped");
    expect(workflowRunning(run.runId)).toBe(false);
});

// A step queued behind `maxParallel` can still be published, marked running and given a loop after the run stops;
// runLoop checks its own stop signal first, so no turn is wasted, only bookkeeping.
test("a step queued behind maxParallel never opens a loop once the run is stopped", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    // One slot, two roots: `queued` holds the door while `first` runs, and `first` presses Stop.
    const design = workflow([step("first"), step("queued")], { maxParallel: 1 });
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    const stopper: TurnFn = async function* turn() {
        stopWorkflowRun(run.runId);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, stopper);

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("stopped");
    const queued = settled?.steps.find((entry) => entry.stepId === "queued");
    expect(queued?.state).toBe("stopped");
    expect(await services.loops.get(queued?.conversationId ?? "")).toBeUndefined();
    expect(queued?.detail?.length).toBeGreaterThan(0);
    expect(queued?.detail).not.toBe(settled?.steps.find((entry) => entry.stepId === "first")?.detail);
    expect(await services.loops.get(settled?.steps[0]?.conversationId ?? "")).toEqual(expect.any(Object));
});

test("a resumed run replays the steps that already finished instead of paying for them again", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("done-already"), step("unfinished", { needs: ["done-already"] })]);
    const run = openRun(design, REPOS, 1);
    // The record as a daemon death would leave it: the first step finished, the second never started.
    await services.workflowRuns.start({
        ...run,
        steps: run.steps.map((entry) =>
            entry.stepId === "done-already"
                ? { ...entry, state: "done" as const, iterations: 1, document: { done: true, reason: "settled last time" } }
                : entry,
        ),
    });
    await runWorkflow(services, (await services.workflowRuns.get(run.runId)) ?? run, claiming(root, prompts));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("settled last time");
    expect((await services.workflowRuns.get(run.runId))?.state).toBe("done");
});

test("restart recovery gives a workflow-owned loop only to the workflow scheduler", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("interrupted")]);
    const opened = openRun(design, REPOS, 1);
    const conversationId = opened.steps[0]!.conversationId;

    // Both journals say the daemon died mid-step; loop recovery must leave a workflow-owned loop alone.
    await services.workflowRuns.start({
        ...opened,
        steps: opened.steps.map((entry) => ({ ...entry, state: "running" as const, startedAt: 1 })),
    });
    await services.loops.start(
        {
            conversationId,
            goal: "interrupted is done",
            prompt: "do interrupted",
            context: "fresh",
            output: { kind: "claim" },
            checks: [],
            maxIterations: 20,
            stallLimit: 3,
            isolated: true,
            worktreeBase: [...REPOS],
            autoLand: false,
        },
        1,
    );

    await resumeWorkflowExecution(services, claiming(root, prompts));
    await vi.waitFor(async () => expect((await services.workflowRuns.get(opened.runId))?.state).toBe("done"), SETTLES);

    expect(prompts).toHaveLength(1);
    expect((await services.workflowRuns.get(opened.runId))?.resumed).toBe(1);
    expect((await services.loops.get(conversationId))?.resumed).toBe(0);
});

test("workflowFaults refuses the graphs the scheduler could not run", () => {
    expect(workflowFaults(workflow([step("a"), step("b", { needs: ["a"] })]))).toEqual([]);

    // Cycle: the scheduler would wait on it forever instead of saying so.
    expect(workflowFaults(workflow([step("a", { needs: ["b"] }), step("b", { needs: ["a"] })])).join(" ")).toContain("in a circle");
    // Dangling dependency: needs a step that isn't in the graph.
    expect(workflowFaults(workflow([step("a", { needs: ["ghost"] })])).join(" ")).toContain("not a step");
    // Nothing to produce or check is the ordinary step, not a fault: one session, one job, done when it is.
    expect(workflowFaults(workflow([step("a", { output: { kind: "none" }, checks: [] })]))).toEqual([]);
    // Continue with no predecessor: nothing to continue from.
    expect(workflowFaults(workflow([step("a", { handoff: "continue" })])).join(" ")).toContain("nothing to continue");
    // Two steps continuing one session would share a conversation and a worktree in parallel.
    expect(
        workflowFaults(
            workflow([step("a"), step("b", { needs: ["a"], handoff: "continue" }), step("c", { needs: ["a"], handoff: "continue" })]),
        ).join(" "),
    ).toContain("only one step can");
});

// A record left `running` by a dead daemon has no abort handle for `stopWorkflowRun`. Both the run and its mid-flight
// steps must be settled: "live" is counted off the steps, so settling only the run would still show one working.
test("a run nothing is driving can still be stopped, steps and all", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("cut-off"), step("never-reached", { needs: ["cut-off"] })]);
    const opened = openRun(design, REPOS, 1);
    await services.workflowRuns.start({
        ...opened,
        steps: opened.steps.map((entry) => (entry.stepId === "cut-off" ? { ...entry, state: "running" as const, iterations: 1 } : entry)),
    });

    expect(workflowRunning(opened.runId)).toBe(false);
    expect(stopWorkflowRun(opened.runId)).toBe(false);

    await abandonRun(services, (await services.workflowRuns.get(opened.runId)) ?? opened, 2);

    const settled = await services.workflowRuns.get(opened.runId);
    expect(settled?.state).toBe("stopped");
    expect(settled?.endedAt).toBe(2);
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["stopped", "stopped"]);
});
