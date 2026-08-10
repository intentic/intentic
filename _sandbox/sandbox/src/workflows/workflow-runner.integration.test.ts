import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type AgentEvent, type AgentTurn, LOOP_DIR, type Workflow, type WorkflowStep, workflowFaults } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { fileLoopsStore } from "../loops/loops-store.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";
import { abandonRun, openRun, resumeWorkflowExecution, runWorkflow, stopWorkflowRun, workflowRunning } from "./workflow-runner.js";

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
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1));
    await runWorkflow(services, run, claiming(root, prompts));

    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("done");
    expect(settled?.steps.map((entry) => entry.state)).toEqual(["done", "done", "done"]);
    // The handover is the whole point of the seam: `build` must have been told what `plan` concluded.
    expect(prompts[1]).toContain("What the steps before you concluded");
    expect(prompts[1]).toContain("plan says true");
    // A `json`-shaped document rides across as JSON, not as a paragraph mentioning it.
    expect(prompts[2]).toContain(`"note": "build"`);
    expect(prompts[1]).toContain(`git diff ${REPOS[0].base}...agent/`);
    // And the first step, which was handed nothing, is not given an empty handover section.
    expect(prompts[0]).not.toContain("What the steps before you concluded");
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
    expect(reportPath).toBe(`.intentic/workflow-runs/${run.runId}/write.md`);
    expect(await readFile(join(root, reportPath ?? ""), "utf8")).toBe(full);
    expect(downstream).toContain(reportPath);
    expect(settled?.steps[0]?.report?.length).toBeLessThan(full.length);
});

/* WHAT THE MODEL ACTUALLY RECEIVES — asserted end to end, through the step brief, the loop brief and the turn,
 * because every one of those layers has at some point added a heading of its own and the reader sees the sum.
 *
 * The complaint this exists for: a step meant to do what the user asked opened with "# Iteration 1 of at most
 * 20 / You are one iteration of a loop that repeats until a goal is met", then the goal, then a memory rule for
 * a successor that would never exist, then a JSON file contract, then a paragraph telling it not to check in.
 * A page of machinery describing machinery, on top of one sentence.
 *
 * `toEqual` rather than a set of `not.toContain`s, deliberately. The property is not "no loop scaffolding" but
 * "nothing at all", and only an exact match keeps it that way — every helpful line anybody adds in future to
 * any of the three layers fails this.
 */
test("an ordinary step's turn prompt is the request, byte for byte", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    // The ordinary step: no prompt, no goal, nothing to produce and nothing to check.
    const design = workflow([step("only", { prompt: undefined, goal: undefined, output: { kind: "none" }, checks: [] })]);
    const run = await services.workflowRuns.start(openRun(design, REPOS, 1, "make the importer handle empty files"));
    const capture: TurnFn = async function* turn(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        yield { kind: "done" } as AgentEvent;
    };
    await runWorkflow(services, run, capture);

    expect(prompts).toEqual(["make the importer handle empty files"]);
    // And it is DONE after that one turn — nothing was declared, so the turn ending is the whole of finishing.
    const settled = await services.workflowRuns.get(run.runId);
    expect(settled?.state).toBe("done");
    expect(settled?.steps[0]?.iterations).toBe(1);
});

// A step that declares its own job still gets the brief, because for that one the request is context rather
// than the instruction — the framing is what an ORDINARY step drops, not something the feature lost.
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
    // Still no loop scaffolding: it declared nothing to produce and nothing to check, so it is one turn.
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
    // Skipped, not failed — one broken step must not be reported four times.
    expect(states.get("after-bad")).toBe("skipped");
    // The independent branch is untouched, which is the reason failure is per-branch at all.
    expect(states.get("sibling")).toBe("done");
    expect(settled?.state).toBe("failed");
    expect(settled?.steps.find((entry) => entry.stepId === "after-bad")?.detail).toContain(`"bad"`);
});

/* THE RUN THAT USED TO LIE. A step that declares no output and no checks is the ordinary shape a design gets
 * written in, and for that step "the turn finished" is the whole bar — so a turn the provider REFUSED was
 * settling `done` with an empty report, the step after it was handed "(this step finished without saying
 * anything)", and the run reported every step complete having run none of them. The refusal is the answer. */
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
    // The provider's own sentence, on the step — the only thing anyone can act on.
    expect(settled?.steps.find((entry) => entry.stepId === "attempt")?.detail).toBe(refusal);
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

    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (peak >= 4) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(peak).toBe(4);

    release();
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

    // The sharing IS the mechanism: same conversation means same fleet card, same worktree, same transcript.
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
    // One iteration ran, and the abort reached the loop rather than waiting for its ceiling.
    expect(settled?.steps.find((entry) => entry.stepId === "slow")?.iterations).toBe(1);
    expect(settled?.steps.find((entry) => entry.stepId === "never")?.state).toBe("stopped");
    expect(workflowRunning(run.runId)).toBe(false);
});

/* THE STOP RACE A WIDE GRAPH HAS, and the reason the abort is asked about on BOTH sides of the slot.
 *
 * A step past its dependencies but over `maxParallel` waits for a slot, and it waits as long as the steps ahead
 * of it take — an agent turn each. The guard before the queue had long since passed by then, so a run stopped
 * in that window still let the queued step walk into `execute`: it published itself to the fleet card, wrote
 * itself `running` in the ledger, and opened a loop record. No TURN was wasted — runLoop asks its own stop
 * signal before it calls one, and the relay gets there first — which is why the cost of this is bookkeeping
 * rather than money. But it is bookkeeping two surfaces read: a step flickering into `running` after the user
 * pressed Stop, and a row in the loops manifest for a step that never ran an iteration.
 */
test("a step queued behind maxParallel never opens a loop once the run is stopped", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    // One slot and two independent roots, so `queued` is holding the door while `first` runs — and `first` is
    // what presses Stop.
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
    /* THE ASSERTION THAT SEPARATES THE FIX FROM THE BUG. Both spellings settle the step as `stopped` with no
     * iterations, so the step's own record cannot tell them apart — what can is whether a loop was ever opened
     * on its conversation, and whether the run says the step never started or merely stopped like the rest. */
    expect(await services.loops.get(queued?.conversationId ?? "")).toBeUndefined();
    expect(queued?.detail).toBe("The run was stopped before this step started.");
    // The step that DID run still opened its loop — the guard must not swallow work that was already going.
    expect(await services.loops.get(settled?.steps[0]?.conversationId ?? "")).toBeDefined();
});

test("a resumed run replays the steps that already finished instead of paying for them again", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("done-already"), step("unfinished", { needs: ["done-already"] })]);
    const run = openRun(design, REPOS, 1);
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

test("restart recovery gives a workflow-owned loop only to the workflow scheduler", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const design = workflow([step("interrupted")]);
    const opened = openRun(design, REPOS, 1);
    const conversationId = opened.steps[0]!.conversationId;

    // Both journals say the daemon died during this step. The workflow coordinator owns the restart: generic
    // loop recovery must leave the matching loop alone or two pumps race the same conversation and worktree.
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
    await vi.waitFor(async () => expect((await services.workflowRuns.get(opened.runId))?.state).toBe("done"));

    expect(prompts).toHaveLength(1);
    expect((await services.workflowRuns.get(opened.runId))?.resumed).toBe(1);
    expect((await services.loops.get(conversationId))?.resumed).toBe(0);
});

test("workflowFaults refuses the graphs the scheduler could not run", () => {
    expect(workflowFaults(workflow([step("a"), step("b", { needs: ["a"] })]))).toEqual([]);

    // A cycle: the scheduler would wait on it forever rather than saying so.
    expect(workflowFaults(workflow([step("a", { needs: ["b"] }), step("b", { needs: ["a"] })])).join(" ")).toContain("in a circle");
    // A dangling dependency.
    expect(workflowFaults(workflow([step("a", { needs: ["ghost"] })])).join(" ")).toContain("not a step");
    /* Nothing to produce and nothing to check is the ORDINARY step and no fault at all — it is one session with
     * one job, finished when the session is. This was refused, on a rule borrowed from loops where it is right
     * (a loop with no bar has no reason to run twice) and wrong here (a step was never started in order to
     * repeat). The cost of the rule was that every step had to declare something before the graph would save,
     * and the cheapest something was a `claim` — a verdict file nobody reads, a page of contract in the prompt,
     * and a way for a step that did the work to fail for not describing it. */
    expect(workflowFaults(workflow([step("a", { output: { kind: "none" }, checks: [] })]))).toEqual([]);
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
    const opened = openRun(design, REPOS, 1);
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
