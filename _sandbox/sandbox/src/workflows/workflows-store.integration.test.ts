import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow, WorkflowRun } from "@intentic/sandbox-contract";
import { afterEach, expect, test } from "vitest";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const root = async (): Promise<string> => {
    const path = await mkdtemp(join(tmpdir(), "workflow-store-"));
    roots.push(path);
    return path;
};

const workflow = (id: string, name = id): Workflow => ({
    id,
    name,
    maxParallel: 1,
    steps: [
        {
            id: "only",
            title: "Only",
            goal: "done",
            prompt: "do it",
            needs: [],
            handoff: "fresh",
            output: { kind: "none" },
            checks: [],
            context: "fresh",
        },
    ],
});

const run = (runId: string, startedAt: number): WorkflowRun => ({
    runId,
    workflow: workflow("wf"),
    repos: [{ repo: "root", base: "1111111111111111111111111111111111111111" }],
    state: "running",
    startedAt,
    resumed: 0,
    steps: [{ stepId: "only", state: "pending", conversationId: `wf-${runId}-only`, iterations: 0 }],
});

test("create never overwrites and update never invents a workflow", async () => {
    const store = fileWorkflowsStore(join(await root(), "workflows.json"));

    expect(await store.save(workflow("same", "first"), true)).toBe("saved");
    expect(await store.save(workflow("same", "collision"), true)).toBe("conflict");
    expect((await store.get("same"))?.name).toBe("first");
    expect(await store.save(workflow("missing"), false)).toBe("missing");
    expect(await store.save(workflow("same", "updated"), false)).toBe("saved");
    expect((await store.get("same"))?.name).toBe("updated");
});

test("retention never evicts a run that is still being driven", async () => {
    const store = fileWorkflowRunsStore(join(await root(), "workflow-runs.json"));
    const active = run("active", 0);
    await store.start(active);

    for (let n = 1; n <= 55; n += 1) {
        const ended = run(`ended-${n}`, n);
        await store.start(ended);
        await store.settle(ended.runId, "done", n);
    }

    const runs = await store.list();
    expect(runs.find((entry) => entry.runId === active.runId)?.state).toBe("running");
    expect(runs.filter((entry) => entry.state !== "running")).toHaveLength(50);
    expect(runs.some((entry) => entry.runId === "ended-1")).toBe(false);
});

test("evicting or forgetting a run removes its complete-report artifacts", async () => {
    const dir = await root();
    const store = fileWorkflowRunsStore(join(dir, "workflow-runs.json"));
    const artifact = (runId: string): string => join(dir, "workflow-runs", runId, "only.md");
    const writeArtifact = async (runId: string): Promise<void> => {
        await mkdir(join(dir, "workflow-runs", runId), { recursive: true });
        await writeFile(artifact(runId), `${runId} report`);
    };

    for (let n = 1; n <= 51; n += 1) {
        const ended = run(`ended-${n}`, n);
        await store.start(ended);
        await store.settle(ended.runId, "done", n);
        if (n === 1 || n === 51) {
            await writeArtifact(ended.runId);
        }
    }

    expect(await store.get("ended-1")).toBeUndefined();
    await expect(access(artifact("ended-1"))).rejects.toThrow();

    await store.forget("ended-51");
    expect(await store.get("ended-51")).toBeUndefined();
    await expect(access(artifact("ended-51"))).rejects.toThrow();
});
