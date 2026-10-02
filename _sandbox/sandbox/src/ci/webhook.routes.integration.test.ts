import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { Hono } from "hono";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import type { Services } from "../composition.js";
import { fileSendersStore } from "../automations/senders-store.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { fileCiStore } from "./ci-store.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";
import { createCiHookReconciler } from "./hooks.js";
import { createCiWebhookRoute } from "./webhook.routes.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy } from "../testing.js";

// The push half, recorded rather than fed to a live /events feed: subscribing for real would start the runtime
// sampler (tmux, procfs) for a fact these tests state in one line.
const { published } = { published: [] as string[] };
jest.mock("../seams/runtime-feed.js", () => ({ publishRuntimeChange: (...domains: string[]) => published.push(...domains) }));

// What reaches main's fix agent, recorded at its door: what it does with a failure is main-fixer.integration.test.ts's.
const heardJobs: unknown[] = [];
jest.mock("./main-fixer.js", () => ({
    jobFailed: async (_services: unknown, _project: unknown, job: unknown) => {
        heardJobs.push(job);
        return "code";
    },
    runFinished: async () => {},
}));

// The receiver touches ciStore/ciRuns/workspace/capabilities plus the listener dispatch path
// (automations/activity/logger); `unstubbed` keeps the fake that small: the listeners.integration.test.ts convention.
// Repair off unless a test says otherwise: with it on, main's failures are its fix agent's and reach no automation (the
// test that says so below), and these tests are about what an automation hears.
const harness = async (automationId: string, narrow: { eventType?: string; branch?: string; channelId?: string } = {}, autoRepair = false) => {
    const root = mkdtempSync(join(tmpdir(), "ci-webhook-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const automations = fileAutomationsStore(
        join(root, `${STATE_DIR}`, "config", "automations.json"),
        join(root, `${STATE_DIR}`, "records", "automation-runs.json"),
    );
    await automations.upsert(automationConfig(automationId, { trigger: { kind: "listener", provider: "ci", ...narrow }, prompt: "handle ci" }));
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ autoRepair }) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, `${STATE_DIR}`, "records", "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const prompts: string[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    // The failed-jobs enrichment call is the only vendor fetch the receiver makes.
    const fetchFn: FetchFn = (async () =>
        new Response(JSON.stringify({ jobs: [{ id: 1, name: "lint", conclusion: "failure" }] }), { status: 200 })) as FetchFn;
    const app = new Hono();
    app.post("/ci/webhook/:host", createCiWebhookRoute(drivenBy(services, wake), fetchFn));
    return { app, services, prompts, root };
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
    // Nothing moved, so nothing is announced: a refused delivery must not make every open board re-read.
    expect(published).not.toContain("ci");
});

// The delivery is the only moment the daemon knows a run ended; without the push an open board waits out its own poll.
test("a delivery announces the ci domain, so an open board re-reads without waiting for its poll", async () => {
    const { app, services } = await harness("wh-push");
    published.length = 0;
    expect((await deliver(app, await services.ciStore.secret(), workflowRun("success"))).status).toBe(200);
    expect(published).toContain("ci");
});

test("a failed run freshens the cache with failed jobs and wakes the ci automation", async () => {
    const { app, services, prompts } = await harness("wh-failed");
    // A fresh (empty) sweep, so the delivery's upsert is visible through sweep() below.
    services.ciRuns.replace([]);
    const response = await deliver(app, await services.ciStore.secret(), workflowRun("failure"));
    expect(response.status).toBe(200);
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 7, status: "failed", failedJobs: ["lint"] }]);
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("failed");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
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
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_succeeded");
    expect(prompts[0]).toContain("pipeline_fixed");
});

// The mirror of the test above, and the reason `pipeline_broken` exists: a branch that was already failing keeps
// firing `pipeline_failed` on every push, and only the run that broke it is news.
test("a failure after a recorded success dispatches pipeline_failed AND pipeline_broken; a second failure does not", async () => {
    const { app, services, prompts } = await harness("wh-broken");
    await services.ciStore.recordConclusion("web", "main", "success", 1);
    const secret = await services.ciStore.secret();
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain("pipeline_broken");

    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(2), SETTLES);
    expect(prompts[1]).toContain("pipeline_failed");
    expect(prompts[1]).not.toContain("pipeline_broken");
});

// A workspace where every agent pushes its own branch is exactly where an unnarrowed CI trigger is useless.
test("a branch-narrowed trigger ignores a run on another branch", async () => {
    const { app, services, prompts } = await harness("wh-branch", { branch: "release" });
    expect((await deliver(app, await services.ciStore.secret(), workflowRun("failure"))).status).toBe(200);
    // The conclusion is still recorded: the memory is about the repo's branches, not about who was listening.
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
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "gitlab", kind: "cli", config: { provider: "gitlab", url: "https://gitlab.example.com", token: "T" } });
    const automations = fileAutomationsStore(
        join(root, `${STATE_DIR}`, "config", "automations.json"),
        join(root, `${STATE_DIR}`, "records", "automation-runs.json"),
    );
    await automations.upsert(
        automationConfig("wh-gitlab", { trigger: { kind: "listener", provider: "ci", eventType: "pipeline_succeeded" }, prompt: "p" }),
    );
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, `${STATE_DIR}`, "records", "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const prompts: string[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    const app = new Hono();
    app.post("/ci/webhook/:host", createCiWebhookRoute(drivenBy(services, wake), (async () => new Response("[]")) as FetchFn));

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
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_succeeded");
    expect(prompts[0]).toContain("gitlab.example.com/group/app/-/pipelines/42");
});

const workflowJob = (conclusion: string | null, action = "completed") => ({
    action,
    workflow_job: {
        id: 70,
        run_id: 7,
        name: "verify-core",
        workflow_name: "CI",
        head_branch: "main",
        head_sha: "abc1234def",
        html_url: "https://github.com/acme/web/actions/runs/7/job/70",
        status: action === "completed" ? "completed" : "in_progress",
        conclusion,
        steps: [
            { name: "Set up job", conclusion: "success" },
            { name: "Run tests", conclusion: conclusion === "failure" ? "failure" : null },
        ],
    },
    repository: { full_name: "acme/web" },
});

// The whole point of hearing jobs one by one: the fix agent starts at the first failure, not when the run ends.
test("a failed job's own delivery reaches main's fix agent at once, with the step that failed it", async () => {
    const { app, services } = await harness("wh-job");
    heardJobs.length = 0;
    const response = await deliver(app, await services.ciStore.secret(), workflowJob("failure"), { "x-github-event": "workflow_job" });
    expect(response.status).toBe(200);
    await waitFor(() => expect(heardJobs).toHaveLength(1), SETTLES);
    expect(heardJobs[0]).toEqual({
        runId: 7,
        jobId: 70,
        name: "verify-core",
        branch: "main",
        workflow: "CI",
        sha: "abc1234def",
        url: "https://github.com/acme/web/actions/runs/7/job/70",
        step: "Run tests",
    });
    // A job is no run: nothing is announced to automations until the run itself ends.
    expect(await services.ciStore.lastConclusion("web", "main")).toBeUndefined();
});

test("a job that passed, was cancelled, or is still going is acknowledged and dropped", async () => {
    const { app, services } = await harness("wh-job-ignored");
    heardJobs.length = 0;
    const secret = await services.ciStore.secret();
    for (const payload of [workflowJob("success"), workflowJob("cancelled"), workflowJob(null, "in_progress")]) {
        const response = await deliver(app, secret, payload, { "x-github-event": "workflow_job" });
        expect(((await response.json()) as { ignored?: boolean }).ignored).toBe(true);
    }
    expect(heardJobs).toEqual([]);
});

test("a gitlab Job Hook's failure reaches the fix agent with gitlab's own reason; a job allowed to fail is none", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-webhook-gl-job-"));
    const dir = join(root, "app");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "git@gitlab.example.com:group/app.git"]);
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "gitlab", kind: "cli", config: { provider: "gitlab", url: "https://gitlab.example.com", token: "T" } });
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const app = new Hono();
    app.post("/ci/webhook/:host", createCiWebhookRoute(services, (async () => new Response("[]")) as FetchFn));
    const hook = (over: Record<string, unknown>) => ({
        object_kind: "build",
        build_id: 300,
        pipeline_id: 42,
        build_name: "test",
        build_status: "failed",
        build_allow_failure: false,
        build_failure_reason: "script_failure",
        ref: "main",
        tag: false,
        sha: "abc",
        project: { path_with_namespace: "group/app", web_url: "https://gitlab.example.com/group/app" },
        ...over,
    });
    const send = async (payload: unknown) =>
        app.request("/ci/webhook/gitlab", {
            method: "POST",
            headers: { "content-type": "application/json", "x-gitlab-event": "Job Hook", "x-gitlab-token": await services.ciStore.secret() },
            body: JSON.stringify(payload),
        });
    heardJobs.length = 0;

    expect((await send(hook({}))).status).toBe(200);
    await waitFor(() => expect(heardJobs).toHaveLength(1), SETTLES);
    expect(heardJobs[0]).toEqual({
        runId: 42,
        jobId: 300,
        name: "test",
        branch: "main",
        sha: "abc",
        url: "https://gitlab.example.com/group/app/-/jobs/300",
        reason: "script_failure",
    });
    const allowed = await send(hook({ build_allow_failure: true }));
    expect(((await allowed.json()) as { ignored?: boolean }).ignored).toBe(true);
    const passed = await send(hook({ build_status: "success" }));
    expect(((await passed.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(heardJobs).toHaveLength(1);
});

// Identity is the forge's id, and the name is display data: after a rename git and the API follow redirects, the hook
// is still found, and every delivery names the repository by its new name.
test("a delivery naming a renamed repository is matched on the repository's id, which the reconcile learned", async () => {
    const { app, services, prompts, root } = await harness("wh-renamed");
    // SAFETY: the reconciler calls its transport with (url, init) only; the repository read answers its new name.
    const forge: FetchFn = (async (input: RequestInfo | URL) =>
        String(input) === "https://api.github.com/repos/acme/web"
            ? new Response(JSON.stringify({ id: 99, full_name: "acme/web-next", default_branch: "main" }))
            : new Response("[]")) as FetchFn;
    const warned: string[] = [];
    await createCiHookReconciler(
        {
            workspace: { root },
            capabilities: services.capabilities,
            ciStore: services.ciStore,
            config: { sandbox: { publicUrl: "https://sandbox.example.com" } },
            logger: unstubbed<Services["logger"]>("logger", { warn: (...args: unknown[]) => void warned.push(String(args[1])) }),
        },
        forge,
    ).reconcile();

    const renamed = { ...workflowRun("failure"), repository: { id: 99, full_name: "acme/web-next" } };
    expect(await (await deliver(app, await services.ciStore.secret(), renamed)).json()).toEqual({ ok: true });
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_failed");
    // Another repository that took the old name is not this one.
    const other = { ...workflowRun("failure"), repository: { id: 7, full_name: "acme/web-next" } };
    expect(await (await deliver(app, await services.ciStore.secret(), other)).json()).toEqual({ ok: true, ignored: true });
    // The remote still names the old path, which the log says.
    expect(warned).toEqual(["ci: the repository's remote names it by an old path"]);
});

// One failed main run, one agent: with Repair on, the default branch's failure is its fix agent's (main-fixer.ts), and
// an automation told to "push the fix to the branch that failed" would be a second agent pushing to main.
test("while Repair is on, the default branch's failure events reach no automation; its pass, and other branches, still do", async () => {
    const { app, services, prompts } = await harness("wh-repair", {}, true);
    const secret = await services.ciStore.secret();
    await services.ciStore.recordConclusion("web", "main", "success", 1);
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    expect((await deliver(app, secret, workflowRun("success"))).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_fixed");
    expect(prompts[0]).not.toContain("pipeline_failed");
    expect(prompts[0]).not.toContain("pipeline_broken");

    const feature = workflowRun("failure");
    expect((await deliver(app, secret, { ...feature, workflow_run: { ...feature.workflow_run, id: 8, head_branch: "agent/x" } })).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(2), SETTLES);
    expect(prompts[1]).toContain("pipeline_failed");
});

test("while Repair is on, an automation that names the default branch still hears it fail", async () => {
    const { app, services, prompts } = await harness("wh-repair-main", { branch: "main" }, true);
    const secret = await services.ciStore.secret();
    await services.ciStore.recordConclusion("web", "main", "success", 1);
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_broken");
});
