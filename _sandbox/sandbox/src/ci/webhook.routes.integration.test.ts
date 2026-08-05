import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGit } from "@intentic/scaffold";
import { Hono } from "hono";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { fileCiStore } from "./ci-store.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";
import { createCiWebhookRoute } from "./webhook.routes.js";

// The receiver touches ciStore/ciRuns/workspace/capabilities plus the listener dispatch path
// (automations/activity/logger); `unstubbed` keeps the fake that small — the listeners.integration.test.ts convention.
const harness = async (automationId: string, narrow: { eventType?: string; branch?: string; channelId?: string } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "ci-webhook-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, ".intentic", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const automations = fileAutomationsStore(join(root, ".intentic", "automations.json"));
    await automations.upsert({
        id: automationId,
        trigger: { kind: "listener", provider: "ci", ...narrow },
        prompt: "handle ci",
        enabled: true,
    });
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        ciStore: fileCiStore(join(root, ".intentic", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, ".intentic", "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const prompts: string[] = [];
    const wake: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    // The failed-jobs enrichment call is the only vendor fetch the receiver makes.
    const fetchFn: FetchFn = (async () =>
        new Response(JSON.stringify({ jobs: [{ id: 1, name: "lint", conclusion: "failure" }] }), { status: 200 })) as FetchFn;
    const app = new Hono();
    app.post("/ci/webhook/:host", createCiWebhookRoute(services, wake, fetchFn));
    return { app, services, prompts };
};

const workflowRun = (conclusion: string) => ({
    action: "completed",
    workflow_run: {
        id: 7,
        display_title: "fix: the thing",
        head_branch: "main",
        head_sha: "abc1234def",
        status: "completed",
        conclusion,
        html_url: "https://github.com/acme/web/actions/runs/7",
        created_at: "2026-07-29T10:00:00Z",
        run_started_at: "2026-07-29T10:00:10Z",
        updated_at: "2026-07-29T10:02:10Z",
        actor: { login: "alice" },
    },
    repository: { full_name: "acme/web" },
});

const deliver = async (app: Hono, secret: string, payload: unknown, over: Record<string, string> = {}): Promise<Response> => {
    const body = JSON.stringify(payload);
    return app.request("/ci/webhook/github", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-github-event": "workflow_run",
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
            ...over,
        },
        body,
    });
};

test("an unsigned or mis-signed delivery is refused", async () => {
    const { app } = await harness("wh-auth");
    const response = await deliver(app, "not-the-secret", workflowRun("failure"));
    expect(response.status).toBe(401);
});

test("a failed run freshens the cache with failed jobs and wakes the ci automation", async () => {
    const { app, services, prompts } = await harness("wh-failed");
    // A fresh (empty) sweep, so the delivery's upsert is visible through sweep() below.
    services.ciRuns.replace([]);
    const response = await deliver(app, await services.ciStore.secret(), workflowRun("failure"));
    expect(response.status).toBe(200);
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 7, status: "failed", failedJobs: ["lint"] }]);
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("failed");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 3000 });
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain(`"lint"`);
    expect(prompts[0]).toContain(`"channelId":"web"`);
});

test("a success after a failure dispatches pipeline_succeeded AND pipeline_fixed in one wake", async () => {
    const { app, services, prompts } = await harness("wh-fixed");
    await services.ciStore.recordConclusion("web", "main", "failed", 1);
    const response = await deliver(app, await services.ciStore.secret(), workflowRun("success"));
    expect(response.status).toBe(200);
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("success");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 3000 });
    expect(prompts[0]).toContain("pipeline_succeeded");
    expect(prompts[0]).toContain("pipeline_fixed");
});

// The mirror of the test above, and the reason `pipeline_broken` exists: a branch that was already red keeps
// firing `pipeline_failed` on every push, and only the run that turned it red is news.
test("a failure after a recorded success dispatches pipeline_failed AND pipeline_broken; a second failure does not", async () => {
    const { app, services, prompts } = await harness("wh-broken");
    await services.ciStore.recordConclusion("web", "main", "success", 1);
    const secret = await services.ciStore.secret();
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 3000 });
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain("pipeline_broken");

    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 3000 });
    expect(prompts[1]).toContain("pipeline_failed");
    expect(prompts[1]).not.toContain("pipeline_broken");
});

// A workspace where every agent pushes its own branch is exactly where an unnarrowed CI trigger is useless.
test("a branch-narrowed trigger ignores a run on another branch", async () => {
    const { app, services, prompts } = await harness("wh-branch", { branch: "release" });
    expect((await deliver(app, await services.ciStore.secret(), workflowRun("failure"))).status).toBe(200);
    // The conclusion is still recorded — the memory is about the repo's branches, not about who was listening.
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(prompts).toEqual([]);
});

test("phases, foreign events and unmapped projects are acknowledged and dropped", async () => {
    const { app, services, prompts } = await harness("wh-ignored");
    const secret = await services.ciStore.secret();
    const inFlight = await deliver(app, secret, { ...workflowRun("failure"), action: "in_progress" });
    expect(((await inFlight.json()) as { ignored?: boolean }).ignored).toBe(true);
    const foreign = await deliver(app, secret, workflowRun("failure"), { "x-github-event": "push" });
    expect(((await foreign.json()) as { ignored?: boolean }).ignored).toBe(true);
    const unmapped = await deliver(app, secret, { ...workflowRun("failure"), repository: { full_name: "acme/other" } });
    expect(((await unmapped.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(await services.ciStore.lastConclusion("web", "main")).toBeUndefined();
    expect(prompts).toEqual([]);
});

test("a gitlab delivery authenticates by token echo and normalizes the Pipeline Hook shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-webhook-gl-"));
    const dir = join(root, "app");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "git@gitlab.example.com:group/app.git"]);
    const capabilities = fileCapabilitiesStore(join(root, ".intentic", "capabilities.json"));
    await capabilities.upsert({ id: "gitlab", kind: "cli", config: { provider: "gitlab", url: "https://gitlab.example.com", token: "T" } });
    const automations = fileAutomationsStore(join(root, ".intentic", "automations.json"));
    await automations.upsert({
        id: "wh-gitlab",
        trigger: { kind: "listener", provider: "ci", eventType: "pipeline_succeeded" },
        prompt: "p",
        enabled: true,
    });
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        ciStore: fileCiStore(join(root, ".intentic", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, ".intentic", "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const prompts: string[] = [];
    const wake: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    const app = new Hono();
    app.post("/ci/webhook/:host", createCiWebhookRoute(services, wake, (async () => new Response("[]")) as FetchFn));

    const payload = {
        object_attributes: { id: 42, ref: "main", sha: "abc", status: "success", created_at: "2026-07-29T10:00:00Z", duration: 90 },
        project: { path_with_namespace: "group/app", web_url: "https://gitlab.example.com/group/app" },
        user: { name: "Alice", username: "alice" },
    };
    const refused = await app.request("/ci/webhook/gitlab", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event": "Pipeline Hook", "x-gitlab-token": "wrong" },
        body: JSON.stringify(payload),
    });
    expect(refused.status).toBe(401);
    const accepted = await app.request("/ci/webhook/gitlab", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event": "Pipeline Hook", "x-gitlab-token": await services.ciStore.secret() },
        body: JSON.stringify(payload),
    });
    expect(accepted.status).toBe(200);
    expect(await services.ciStore.lastConclusion("app", "main")).toBe("success");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 3000 });
    expect(prompts[0]).toContain("pipeline_succeeded");
    expect(prompts[0]).toContain("gitlab.example.com/group/app/-/pipelines/42");
});
