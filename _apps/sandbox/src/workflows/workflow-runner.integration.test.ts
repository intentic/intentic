import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { type AgentEvent, type AgentTurn, LOOP_DIR, type Workflow, type WorkflowStep, workflowFaults } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fileLoopsStore } from "../loops/loops-store.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";
import { abandonRun, openRun, runWorkflow, stopWorkflowRun, workflowRunning } from "./workflow-runner.js";

/* The scheduler's graph behaviour, end to end. Every test here is about the SEAM between steps, because that
 * is the only thing this module owns — a step's own execution is a loop, and loops are tested next door.
 *
 * The tree is a temp dir with no git in it, so `treeDigest` answers the same empty digest every time and the
 * stall detector is live by default. Each step therefore needs its own reason to stop, which is exactly the
 * discipline these tests want: nothing here succeeds by accident.
 */

const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        loops: fileLoopsStore(join(root, "loops.json")),
        workflows: fileWorkflowsStore(join(root, "workflows.json")),
        workflowRuns: fileWorkflowRunsStore(join(root, "workflow-runs.json")),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        agents: unstubbed<Services["agents"]>("agents", { sessionIdOf: () => undefined }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { conversationDir: () => root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { open: async () => {}, append: async () => {} }),
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
    maxIterations: 2,
    stallLimit: 99,
    ...over,
});

const workflow = (steps: readonly WorkflowStep[], over: Partial<Workflow> = {}): Workflow => ({
    id: "wf",
    name: "a workflow",
    steps: [...steps],
    isolated: false,
    maxParallel: 4,
    ...over,
});

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "workflows-"));

/* A turn that writes the verdict its step needs, so the step's loop converges on iteration 1. `claims` decides
 * per step id whether it says done — the lever every failure test below pulls. It reads the step from the
 * conversation id (`wf-<run>-<step>`) rather than the prompt, so a `continue` step sharing a conversation is
 * visible to the test as the same id, which is the property those tests are checking.
 */
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
    const run = await services.workflowRuns.start(openRun(design, 1));
    await runWorkflow(services, run, claiming(root, prompts));

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("done");
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["done", "done", "done"]);
    // The handover is the whole point of the seam: `build` must have been told what `plan` concluded.
    expect(prompts[1]).toContain("What the steps before you concluded");
    expect(prompts[1]).toContain("plan says true");
    // A `json`-shaped document rides across as JSON, not as a paragraph mentioning it.
    expect(prompts[2]).toContain(`"note": "build"`);
    // And the first step, which was handed nothing, is not given an empty handover section.
    expect(prompts[0]).not.toContain("What the steps before you concluded");
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
    const run = await services.workflowRuns.start(openRun(design, 1));
    await runWorkflow(
        services,
        run,
        claiming(root, [], (id) => id !== "bad"),
    );

    const settled = await services.workflowRuns.get(run.runId);
    const states = new Map(settled?.steps.map((entry) => [entry.stepId, entry.state]));
    expect(states.get("bad")).toBe("failed");
    // Skipped, not failed — one broken step must not be reported four times.
    expect(states.get("after-bad")).toBe("skipped");
    // The independent branch is untouched, which is the reason failure is per-branch at all.
    expect(states.get("sibling")).toBe("done");
    expect(settled?.state).toBe("failed");
    expect(settled?.steps.find((entry) => entry.stepId === "after-bad")?.detail).toContain(`"bad"`);
});

test("a fan-in step waits for every branch and is handed all of them", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("left"), step("right"), step("merge", { needs: ["left", "right"] })]);
    const run = await services.workflowRuns.start(openRun(design, 1));
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
    const run = await services.workflowRuns.start(openRun(design, 1));
    await runWorkflow(services, run, counting);

    expect(peak).toBeLessThanOrEqual(2);
    expect((await services.workflowRuns.get(run.runId))?.state).toBe("done");
});

test("a `continue` step runs on its predecessor's conversation; a `fresh` one gets its own", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("first"), step("second", { needs: ["first"], handoff: "continue" }), step("third", { needs: ["first"] })]);
    const run = await services.workflowRuns.start(openRun(design, 1));
    const conversations = new Map(run.steps.map((entry) => [entry.stepId, entry.conversationId]));

    // The sharing IS the mechanism: same conversation means same fleet card, same worktree, same transcript.
    expect(conversations.get("second")).toBe(conversations.get("first"));
    expect(conversations.get("third")).not.toBe(conversations.get("first"));
});

test("the run's spend ceiling stops it before the next step starts, not mid-turn", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const spendy: TurnFn = async function* turn(_services, input: AgentTurn) {
        const conversationId = input.conversationId ?? "";
        await mkdir(join(root, LOOP_DIR, conversationId), { recursive: true });
        await writeFile(join(root, LOOP_DIR, conversationId, `iteration-1.json`), JSON.stringify({ done: true, reason: "ok" }));
        yield { kind: "usage", costUsd: 0.6 } as AgentEvent;
        yield { kind: "done" } as AgentEvent;
    };
    const design = workflow([step("one"), step("two", { needs: ["one"] }), step("three", { needs: ["two"] })], { maxSpendUsd: 1 });
    const run = await services.workflowRuns.start(openRun(design, 1));
    await runWorkflow(services, run, spendy);

    const settled = await services.workflowRuns.get(run.runId);
    // Two steps spend $1.20, which is the first total at or past the ceiling; the third never starts.
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["done", "done", "skipped"]);
    expect(settled?.state).toBe("overspent");
    expect(settled?.detail).toContain("1.20");
});

test("stopping a run stops the loop in flight and starts nothing further", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("slow", { maxIterations: 20 }), step("never", { needs: ["slow"] })]);
    const run = await services.workflowRuns.start(openRun(design, 1));
    // Never writes a verdict, so its loop would run all 20 iterations; the stop is what ends it.
    const endless: TurnFn = async function* turn() {
        stopWorkflowRun(run.runId);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, endless);

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("stopped");
    // One iteration ran, and the abort reached the loop rather than waiting for its ceiling.
    expect(settled?.steps.find((entry) => entry.stepId === "slow")?.iterations).toBe(1);
    expect(settled?.steps.find((entry) => entry.stepId === "never")?.state).toBe("stopped");
    expect(workflowRunning(run.runId)).toBe(false);
});

test("a resumed run replays the steps that already finished instead of paying for them again", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("done-already"), step("unfinished", { needs: ["done-already"] })]);
    const run = openRun(design, 1);
    // The record as a daemon death would leave it: the first step finished and was written down, the second
    // never started.
    await services.workflowRuns.start({
        ...run,
        steps: run.steps.map((entry) =>
            entry.stepId === "done-already"
                ? { ...entry, state: "done" as const, iterations: 1, document: { done: true, reason: "settled last time" } }
                : entry,
        ),
    });
    await runWorkflow(services, (await services.workflowRuns.get(run.runId)) ?? run, claiming(root, prompts));

    // Exactly one turn ran, and it was the unfinished step — handed what the finished one had concluded.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("settled last time");
    expect((await services.workflowRuns.get(run.runId))?.state).toBe("done");
});

test("workflowFaults refuses the graphs the scheduler could not run", () => {
    expect(workflowFaults(workflow([step("a"), step("b", { needs: ["a"] })]))).toEqual([]);

    // A cycle: the scheduler would wait on it forever rather than saying so.
    expect(workflowFaults(workflow([step("a", { needs: ["b"] }), step("b", { needs: ["a"] })])).join(" ")).toContain("in a circle");
    // A dangling dependency.
    expect(workflowFaults(workflow([step("a", { needs: ["ghost"] })])).join(" ")).toContain("not a step");
    // Nothing to produce and nothing to check — it could only ever run out of iterations.
    expect(workflowFaults(workflow([step("a", { output: { kind: "none" }, checks: [] })])).join(" ")).toContain("nothing can tell it");
    // A root that continues a session that does not exist.
    expect(workflowFaults(workflow([step("a", { handoff: "continue" })])).join(" ")).toContain("nothing to continue");
    // Two steps continuing one session would run in parallel on one conversation and one worktree.
    expect(
        workflowFaults(
            workflow([step("a"), step("b", { needs: ["a"], handoff: "continue" }), step("c", { needs: ["a"], handoff: "continue" })]),
        ).join(" "),
    ).toContain("only one step can");
});

/* THE STUCK RUN, and the only way out of it.
 *
 * A record left `running` by a daemon that is gone — replaced by a sandbox update, or dead between a step
 * settling and the run being settled — has no abort handle for `stopWorkflowRun` to find. Stop used to refuse
 * such a run outright ("that run is not going"), which made it permanent: a card with a button that could not
 * work, a step count frozen where the daemon died, and no way off the board. Both halves are asserted because
 * both were wrong on screen: the RUN has to end, and so do the steps it left mid-flight — "1 live" is counted
 * off the steps, so settling only the run leaves the card still claiming a session is working.
 */
test("a run nothing is driving can still be stopped, steps and all", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const design = workflow([step("cut-off"), step("never-reached", { needs: ["cut-off"] })]);
    const opened = openRun(design, 1);
    await services.workflowRuns.start({
        ...opened,
        steps: opened.steps.map((entry) => (entry.stepId === "cut-off" ? { ...entry, state: "running" as const, iterations: 1 } : entry)),
    });

    // Nothing is in flight — this is the state the scheduler is NOT in.
    expect(workflowRunning(opened.runId)).toBe(false);
    expect(stopWorkflowRun(opened.runId)).toBe(false);

    await abandonRun(services, (await services.workflowRuns.get(opened.runId)) ?? opened, 2);

    const settled = await services.workflowRuns.get(opened.runId);
    expect(settled?.state).toBe("stopped");
    expect(settled?.endedAt).toBe(2);
    // Neither the step that was mid-turn nor the one still waiting is left claiming it might yet run.
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["stopped", "stopped"]);
});
