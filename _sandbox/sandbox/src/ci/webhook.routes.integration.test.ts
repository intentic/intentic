import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/base/git";
import { Hono } from "hono";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../store/journals/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import type { Services } from "../composition.js";
import { fileSendersStore } from "../automations/senders-store.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { fileCiStore } from "./ci-store.js";
import type { FetchFn } from "../forge/http.js";
import { createRunsCache } from "./runs-cache.js";
import { createCiHookReconciler } from "./hooks.js";
import { CI_WEBHOOK_PAYLOAD_MAX, createCiWebhookRoute } from "./webhook.routes.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy } from "../seams/turn-starter.testing.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../seams/domain-events.js";
import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { subscribeCiFeed } from "../seams/ci-feed-bus.js";

// The push half, recorded rather than fed to a live /events feed: subscribing for real would start the runtime
// sampler (tmux, procfs) for a fact these tests state in one line.
const { published } = { published: [] as string[] };
jest.mock("../seams/runtime-feed.js", () => ({ publishRuntimeChange: (...domains: string[]) => published.push(...domains) }));

// What a program reading GET /ci/feed hears (ci-feed.ts): every frame since the suite began; a test empties it first.
const heardFeed: CiFeedEvent[] = [];
subscribeCiFeed((event) => void heardFeed.push(event));

// What main's fix agent hears (the pipelines extension's, on its event stream): each failed job's frame, with what the forge
// said of its failure. What it does with one is that extension's main-fixer.integration.test.ts's.
const failedFrames = (): readonly CiFeedEvent[] => heardFeed.filter((event) => event.kind === "job" && event.failed !== undefined);

// The receiver touches ciStore/ciRuns/workspace/capabilities plus the listener dispatch path
// (automations/activity/logger); `unstubbed` keeps the fake that small: the listeners.integration.test.ts convention.
// No extension claims main lines unless a test says otherwise: with one claiming them, main's failures are its fix
// agent's and reach no automation (the test that says so below), and these tests are about what an automation hears.
// The failed-jobs enrichment call is the only vendor fetch the receiver makes; `fetchFn` answers it, at once by default.
const failedLint: FetchFn = (async () => new Response(JSON.stringify({ jobs: [{ id: 1, name: "lint", conclusion: "failure" }] }), { status: 200 })) as FetchFn;

// The pipelines extension, built in under its own directory, as the image bakes it: what may claim main lines.
const builtInPipelines = async (root: string): Promise<string> => {
    const extensionsDir = join(root, "builtin");
    await mkdir(join(extensionsDir, "pipelines"), { recursive: true });
    await writeFile(
        join(extensionsDir, "pipelines", "intentic-extension.json"),
        JSON.stringify({ publisher: "intentic", name: "pipelines", version: "1.0.0", engines: { intentic: "^2.56.0" } }),
    );
    return extensionsDir;
};

const harness = async (
    automationId: string,
    narrow: { eventType?: string; branch?: string; channelId?: string } = {},
    claimed = false,
    fetchFn: FetchFn = failedLint,
) => {
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
    const ciStore = fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json"));
    if (claimed) {
        await ciStore.claimMainLines("intentic.pipelines", true, 1);
    }
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        // The automation inboxes (durable/inbox-store.ts) live beside the holds; a claim holds while its extension, built
        // in here, is on.
        config: unstubbed<Services["config"]>("config", { historyRoot: join(root, "history"), extensionsDir: await builtInPipelines(root) }),
        files: unstubbed<Services["files"]>("files", { read: (path: string) => readFile(path, "utf8").catch(() => undefined) }),
        ciStore,
        // What a wake reads of the sandbox's settings: its defaults.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, `${STATE_DIR}`, "records", "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        // Real actors under a wake's detached run (turn-runs.ts), and a bus for its settle that nobody hears.
        conversations: memoryFleet().conversations,
        events: createDomainEvents(() => {}),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
    });
    const prompts: string[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
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

test("an oversized unsigned delivery is cut off at the byte limit without a Content-Length", async () => {
    const { app } = await harness("wh-too-large");
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent > CI_WEBHOOK_PAYLOAD_MAX) {
                controller.close();
                return;
            }
            const size = sent === 0 ? CI_WEBHOOK_PAYLOAD_MAX : 1;
            sent += size;
            controller.enqueue(new Uint8Array(size));
        },
        cancel() {
            cancelled = true;
        },
    });
    // SAFETY: a streamed request needs Node's duplex flag, absent from the DOM RequestInit type.
    const response = await app.request("/ci/webhook/gitlab", {
        method: "POST",
        headers: { "x-gitlab-token": "wrong" },
        body,
        duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(sent).toBe(CI_WEBHOOK_PAYLOAD_MAX + 1);
    expect(cancelled).toBe(true);
});

// The delivery is the only moment the daemon knows a run ended; without the push an open board waits out its own poll.
test("a delivery announces the ci domain, so an open board re-reads without waiting for its poll", async () => {
    const { app, services } = await harness("wh-push");
    published.length = 0;
    expect((await deliver(app, await services.ciStore.secret(), workflowRun("success"))).status).toBe(200);
    await waitFor(() => expect(published).toContain("ci"), SETTLES);
});

// An open board and a CI-shaped watch learn of a run moving from every phase, not only its end (2026-10-20); what a run
// in flight must not do is reach an automation or record a conclusion.
test("an in-flight run's delivery freshens the cache and announces ci, and wakes nothing", async () => {
    const { app, services, prompts } = await harness("wh-in-flight");
    published.length = 0;
    const running = workflowRun("failure");
    const delivery = { ...running, action: "in_progress", workflow_run: { ...running.workflow_run, status: "in_progress", conclusion: null } };
    const response = await deliver(app, await services.ciStore.secret(), delivery);
    expect(((await response.json()) as { ignored?: boolean }).ignored).toBeUndefined();
    await waitFor(() => expect(published).toContain("ci"), SETTLES);
    expect(services.ciRuns.sweep() ?? []).toEqual([]);
    services.ciRuns.replace([]);
    await deliver(app, await services.ciStore.secret(), delivery);
    await waitFor(() => expect(services.ciRuns.sweep()?.map((run) => run.status)).toEqual(["running"]), SETTLES);
    expect(await services.ciStore.lastConclusion("web", "main")).toBeUndefined();
    expect(prompts).toEqual([]);
});

test("a failed run freshens the cache with failed jobs and wakes the ci automation", async () => {
    const { app, services, prompts } = await harness("wh-failed");
    // A fresh (empty) sweep, so the delivery's upsert is visible through sweep() below.
    services.ciRuns.replace([]);
    const response = await deliver(app, await services.ciStore.secret(), workflowRun("failure"));
    expect(response.status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 7, status: "failed", failedJobs: ["lint"] }]);
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("failed");
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain(`"lint"`);
    expect(prompts[0]).toContain(`"channelId":"web"`);
});

test("a success after a failure dispatches pipeline_succeeded AND pipeline_fixed in one wake", async () => {
    const { app, services, prompts } = await harness("wh-fixed");
    await services.ciStore.recordConclusion("web", "main", "failed", 1);
    const response = await deliver(app, await services.ciStore.secret(), workflowRun("success"));
    expect(response.status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(await services.ciStore.lastConclusion("web", "main")).toBe("success");
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

// GitHub calls a delivery failed that takes ten seconds to answer: a forge slow to list the failed jobs must not be.
test("a finished run is answered before its failed jobs are read, and lands once they are", async () => {
    const { promise: listed, resolve: list } = Promise.withResolvers<void>();
    // SAFETY: the receiver calls its transport with (url, init) only, which this answers as the default one does.
    const slow: FetchFn = (async (...args: Parameters<FetchFn>) => {
        await listed;
        return failedLint(...args);
    }) as FetchFn;
    const { app, services, prompts } = await harness("wh-slow", {}, false, slow);
    services.ciRuns.replace([]);
    expect(await (await deliver(app, await services.ciStore.secret(), workflowRun("failure"))).json()).toEqual({ ok: true });
    expect(services.ciRuns.sweep()).toEqual([]);
    expect(await services.ciStore.lastConclusion("web", "main")).toBeUndefined();
    list();
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 7, status: "failed", failedJobs: ["lint"] }]);
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain(`"lint"`);
});

// Answered at once, two runs of one repository still go in the order they came: a pass that overtook the failure
// before it would read that failure as the branch's last word.
test("a run delivered while the one before it is still being read waits for it", async () => {
    const { promise: listed, resolve: list } = Promise.withResolvers<void>();
    // SAFETY: the receiver calls its transport with (url, init) only, which this answers as the default one does.
    const slow: FetchFn = (async (...args: Parameters<FetchFn>) => {
        await listed;
        return failedLint(...args);
    }) as FetchFn;
    const { app, services } = await harness("wh-order", {}, false, slow);
    const recorded = jest.spyOn(services.ciStore, "recordConclusion");
    const secret = await services.ciStore.secret();
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    const pass = workflowRun("success");
    expect((await deliver(app, secret, { ...pass, workflow_run: { ...pass.workflow_run, id: 8 } })).status).toBe(200);
    list();
    await waitFor(() => expect(recorded.mock.calls.map(([, , status]) => status)).toEqual(["failed", "success"]), SETTLES);
    // The spy counts a call as it starts; the write it makes lands a moment later.
    await waitFor(async () => expect(await services.ciStore.lastConclusion("web", "main")).toBe("success"), SETTLES);
});

// A workspace where every agent pushes its own branch is exactly where an unnarrowed CI trigger is useless.
test("a branch-narrowed trigger ignores a run on another branch", async () => {
    const { app, services, prompts } = await harness("wh-branch", { branch: "release" });
    expect((await deliver(app, await services.ciStore.secret(), workflowRun("failure"))).status).toBe(200);
    // The conclusion is still recorded: the memory is about the repo's branches, not about who was listening.
    await waitFor(async () => expect(await services.ciStore.lastConclusion("web", "main")).toBe("failed"), SETTLES);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(prompts).toEqual([]);
});

test("foreign events and unmapped projects are acknowledged and dropped", async () => {
    const { app, services, prompts } = await harness("wh-ignored");
    const secret = await services.ciStore.secret();
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
        // The automation inboxes (durable/inbox-store.ts) live beside the holds.
        config: unstubbed<Services["config"]>("config", { historyRoot: join(root, "history") }),
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, `${STATE_DIR}`, "records", "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        // Real actors under a wake's detached run (turn-runs.ts), and a bus for its settle that nobody hears.
        conversations: memoryFleet().conversations,
        events: createDomainEvents(() => {}),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
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
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(await services.ciStore.lastConclusion("app", "main")).toBe("success");
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

// The whole point of hearing jobs one by one: main's fix agent starts at the first failure, not when the run ends.
test("a failed job's own delivery is on the CI feed at once, with the step that failed it", async () => {
    const { app, services } = await harness("wh-job");
    heardFeed.length = 0;
    const response = await deliver(app, await services.ciStore.secret(), workflowJob("failure"), { "x-github-event": "workflow_job" });
    expect(response.status).toBe(200);
    expect(failedFrames()).toEqual([
        {
            kind: "job",
            repo: "web",
            host: "github",
            project: "acme/web",
            runId: 7,
            workflow: "CI",
            job: "verify-core",
            branch: "main",
            sha: "abc1234def",
            status: "failed",
            url: "https://github.com/acme/web/actions/runs/7/job/70",
            failed: { jobId: 70, step: "Run tests", steps: ["Run tests"] },
        },
    ]);
    // A job is no run: nothing is announced to automations until the run itself ends.
    expect(await services.ciStore.lastConclusion("web", "main")).toBeUndefined();
});

test("a job still going reaches no feed, but announces ci", async () => {
    const { app, services } = await harness("wh-job-ignored");
    heardFeed.length = 0;
    published.length = 0;
    const response = await deliver(app, await services.ciStore.secret(), workflowJob(null, "in_progress"), { "x-github-event": "workflow_job" });
    // SAFETY: the route answers its JSON acknowledgement, `{ ok, ignored? }`.
    expect(((await response.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(heardFeed).toEqual([]);
    // Its run's job graph is open somewhere, or a watch reads it: each phase is news to them.
    expect(published.filter((domain) => domain === "ci")).toEqual(["ci"]);
});

// The whole point of hearing jobs one by one on the feed: the Deployments extension deploys the moment the job
// publishing its images passes, not when the rest of the run does.
test("every job that ended is a job frame on the CI feed at once, passed, failed or cancelled, as the forge named it", async () => {
    const { app, services } = await harness("wh-job-feed");
    heardFeed.length = 0;
    const secret = await services.ciStore.secret();
    for (const conclusion of ["success", "failure", "cancelled"]) {
        const response = await deliver(app, secret, workflowJob(conclusion), { "x-github-event": "workflow_job" });
        // SAFETY: the route answers its JSON acknowledgement, `{ ok, ignored? }`.
        expect(((await response.json()) as { ignored?: boolean }).ignored).toBeUndefined();
    }
    const url = "https://github.com/acme/web/actions/runs/7/job/70";
    const frame = { kind: "job" as const, repo: "web", host: "github" as const, project: "acme/web", runId: 7, workflow: "CI", job: "verify-core", branch: "main", sha: "abc1234def", url };
    // Only the failure carries what the forge said of it, which main's fix agent reads.
    expect(heardFeed).toEqual([
        { ...frame, status: "success" },
        { ...frame, status: "failed", failed: { jobId: 70, step: "Run tests", steps: ["Run tests"] } },
        { ...frame, status: "canceled" },
    ]);
});

test("every run that ended is a run frame on the CI feed, passed or failed, in the order they arrived", async () => {
    const { app, services } = await harness("wh-run-feed");
    heardFeed.length = 0;
    const secret = await services.ciStore.secret();
    const passing = workflowRun("success");
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    expect((await deliver(app, secret, { ...passing, workflow_run: { ...passing.workflow_run, id: 8, name: "Release" } })).status).toBe(200);
    await waitFor(() => expect(heardFeed).toHaveLength(2), SETTLES);

    expect(heardFeed).toMatchObject([
        { kind: "run", run: { repo: "web", host: "github", runId: 7, status: "failed", branch: "main", sha: "abc1234def" } },
        { kind: "run", run: { repo: "web", host: "github", runId: 8, workflow: "Release", status: "success", branch: "main", sha: "abc1234def" } },
    ]);
});

test("a gitlab Job Hook's failure is on the feed with gitlab's own reason; a job allowed to fail is none", async () => {
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
        // Where a failed job's frame looks up what set its run off: no run of it was delivered here.
        ciRuns: createRunsCache(60_000),
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
    heardFeed.length = 0;

    expect((await send(hook({}))).status).toBe(200);
    expect(failedFrames()).toEqual([
        {
            kind: "job",
            repo: "app",
            host: "gitlab",
            project: "group/app",
            runId: 42,
            job: "test",
            branch: "main",
            sha: "abc",
            status: "failed",
            url: "https://gitlab.example.com/group/app/-/jobs/300",
            failed: { jobId: 300, reason: "script_failure" },
        },
    ]);
    // A job allowed to fail fails nothing main's fix agent would mend; the feed still hears GitLab's own verdict, with no
    // failure of the code's on it.
    heardFeed.length = 0;
    expect((await send(hook({ build_allow_failure: true, build_id: 304 }))).status).toBe(200);
    expect(heardFeed).toMatchObject([{ kind: "job", job: "test", status: "failed", url: "https://gitlab.example.com/group/app/-/jobs/304" }]);
    expect(failedFrames()).toEqual([]);
    // Every job that ended is on the CI feed, the failure and a pass alike; a tag's names no branch a trigger could.
    heardFeed.length = 0;
    const passed = await send(hook({ build_status: "success", build_id: 301, build_name: "publish" }));
    // SAFETY: the route answers its JSON acknowledgement, `{ ok, ignored? }`.
    expect(((await passed.json()) as { ignored?: boolean }).ignored).toBeUndefined();
    await send(hook({ build_id: 303 }));
    const tagged = await send(hook({ build_status: "success", build_id: 302, tag: true }));
    // SAFETY: the route answers its JSON acknowledgement, `{ ok, ignored? }`.
    expect(((await tagged.json()) as { ignored?: boolean }).ignored).toBe(true);
    const frame = { kind: "job" as const, repo: "app", host: "gitlab" as const, project: "group/app", runId: 42, branch: "main", sha: "abc" };
    expect(heardFeed).toEqual([
        { ...frame, job: "publish", status: "success", url: "https://gitlab.example.com/group/app/-/jobs/301" },
        { ...frame, job: "test", status: "failed", url: "https://gitlab.example.com/group/app/-/jobs/303", failed: { jobId: 303, reason: "script_failure" } },
    ]);
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

// One failed main run, one agent: while an extension claims main lines (the pipelines extension, with Repair on), the
// default branch's failure is its fix agent's (main-line-claims.ts), and an automation told to "push the fix to the branch
// that failed" would be a second agent pushing to main.
test("while an extension claims main lines, the default branch's failure events reach no automation; its pass, and other branches, still do", async () => {
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

test("while an extension claims main lines, an automation that names the default branch still hears it fail", async () => {
    const { app, services, prompts } = await harness("wh-repair-main", { branch: "main" }, true);
    const secret = await services.ciStore.secret();
    await services.ciStore.recordConclusion("web", "main", "success", 1);
    expect((await deliver(app, secret, workflowRun("failure"))).status).toBe(200);
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_broken");
});
