import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { type AgentEvent, type AgentTurn, LOOP_DIR, SandboxSettingsSchema, type Workflow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { memoryDoorTokens } from "../auth/door-tokens.js";
import type { Services } from "../composition.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { fileLoopsStore } from "../loops/loops-store.js";
import { createGateRoute } from "./gate.routes.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";

// Gate route end to end: an identity-less runner posts, waits, and is told whether to ship. Each test uses its own
// workflow id: the ceiling is a module singleton keyed by workflow, so ids must not collide.

const REPOS = [{ repo: "root", base: "1111111111111111111111111111111111111111" }] as const;

// One door store for the file: each test names its own workflow id, so credentials never collide.
const DOORS = memoryDoorTokens();
const token = (id: string): Promise<string> => DOORS.ensure("gate", id);

const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        loops: fileLoopsStore(join(root, "loops.json")),
        workflows: fileWorkflowsStore(join(root, "workflows.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        workflowRuns: fileWorkflowRunsStore(join(root, "workflow-runs.json")),
        doorTokens: DOORS,
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        agents: unstubbed<Services["agents"]>("agents", { sessionIdOf: () => undefined }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { conversationDir: () => root, snapshot: async () => REPOS }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { append: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

const gated = (id: string, over: Partial<Workflow> = {}): Workflow => ({
    id,
    name: "release gate",
    maxParallel: 1,
    gate: { step: "judge", field: "release", pass: ["pass"] },
    steps: [
        {
            id: "judge",
            title: "Judge",
            goal: "a release decision exists",
            prompt: "decide whether this ships",
            needs: [],
            handoff: "fresh",
            output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: true }] },
            checks: [],
            context: "fresh",
        },
    ],
    ...over,
});

// Writes the step's verdict file and converges on the first iteration; `release` is the judge's decision, `prompts`
// collects what it was asked.
const judging = (root: string, release: string, prompts: string[] = []): TurnFn =>
    async function* turn(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        const conversationId = input.conversationId ?? "";
        const n = /Iteration (\d+)/.exec(input.prompt)?.[1] ?? "1";
        await mkdir(join(root, LOOP_DIR, conversationId), { recursive: true });
        await writeFile(
            join(root, LOOP_DIR, conversationId, `iteration-${n}.json`),
            JSON.stringify({ done: true, reason: `judged ${release}`, data: { release } }),
        );
        yield { kind: "delta", text: "judged" } as AgentEvent;
        yield { kind: "done" } as AgentEvent;
    };

const appFor = (services: Services, wake: TurnFn): Hono => new Hono().post("/workflows/:id/gate", createGateRoute(services, wake));

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "gate-"));

// No query uses the door's own credential as the bearer header; a query supplies the test's own wording (wrong token,
// deadline) riding the URL like a webhook sender's would.
const post = async (app: Hono, id: string, query?: string, body = ""): Promise<Response> =>
    query === undefined
        ? app.request(`/workflows/${id}/gate`, { method: "POST", body, headers: { authorization: `Bearer ${await token(id)}` } })
        : app.request(`/workflows/${id}/gate?${query}`, { method: "POST", body });

test("a passing judgment ships, and the run is the one the gate started", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await services.workflows.save(gated("wf-pass"), true);
    const response = await post(appFor(services, judging(root, "pass")), "wf-pass");

    expect(response.status).toBe(200);
    const verdict = (await response.json()) as { outcome: string; value: string; runId: string };
    expect(verdict.outcome).toBe("pass");
    expect(verdict.value).toBe("pass");
    expect((await services.workflowRuns.get(verdict.runId))?.state).toBe("done");
});

test("a failing judgment answers fail over a 200, not an HTTP error", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await services.workflows.save(gated("wf-fail"), true);
    const response = await post(appFor(services, judging(root, "fail")), "wf-fail");

    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe("fail");
});

test("the request body reaches the step as the run's request", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    await services.workflows.save(gated("wf-body"), true);
    await post(appFor(services, judging(root, "pass", prompts)), "wf-body", `token=${await token("wf-body")}`, "sha=deadbeef url=https://preview.example");

    expect(prompts[0]).toContain("https://preview.example");
});

test("an unknown id and a workflow with no gate are the same 404", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const { gate: _gate, ...ungated } = gated("wf-ungated");
    await services.workflows.save(ungated, true);
    const app = appFor(services, judging(root, "pass"));

    expect((await post(app, "wf-nothing")).status).toBe(404);
    expect((await post(app, "wf-ungated")).status).toBe(404);
});

test("a wrong token is refused before anything is spent", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    await services.workflows.save(gated("wf-auth"), true);
    const response = await post(appFor(services, judging(root, "pass", prompts)), "wf-auth", "token=not-the-token");

    expect(response.status).toBe(401);
    expect(prompts).toEqual([]);
    expect(await services.workflowRuns.list()).toEqual([]);
});

test("a gate past its daily ceiling refuses without starting a run", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await services.workflows.save(
        gated("wf-ceiling", { gate: { step: "judge", field: "release", pass: ["pass"], dailyMax: 1 } }),
        true,
    );
    const app = appFor(services, judging(root, "pass"));

    expect((await post(app, "wf-ceiling")).status).toBe(200);
    const second = await post(app, "wf-ceiling");
    expect(second.status).toBe(429);
    expect(await services.workflowRuns.list()).toHaveLength(1);
});

test("a gate pointed at a field nobody declares is refused at call time", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await services.workflows.save(gated("wf-broken", { gate: { step: "judge", field: "shipit", pass: ["pass"] } }), true);
    const response = await post(appFor(services, judging(root, "pass")), "wf-broken");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("shipit");
});

test("a run that outlasts the deadline is stopped and answers blocked", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await services.workflows.save(gated("wf-slow"), true);
    const slow: TurnFn = async function* () {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        yield { kind: "done" } as AgentEvent;
    };

    const startedAt = Date.now();
    const response = await post(appFor(services, slow), "wf-slow", `token=${await token("wf-slow")}&wait=0.05`);
    const elapsed = Date.now() - startedAt;

    expect((await response.json()).outcome).toBe("blocked");
    expect(elapsed).toBeLessThan(2_000);
});
