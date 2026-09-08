import { expect, test } from "vitest";
import type { GitHost } from "../capabilities/cli/git-access.js";
import { ciClientFor, type FetchFn, githubRun, githubStatus, gitlabHookRun, gitlabRun, gitlabStatus } from "./providers.js";
import type { CiProject } from "./projects.js";

const githubProject: CiProject = {
    repo: "web",
    project: "acme/web",
    account: { provider: "github", host: "github.com", apiBase: "https://api.github.com", token: "T", httpsUser: "x-access-token" } as GitHost,
};
const gitlabProject: CiProject = {
    repo: "app",
    project: "group/app",
    account: {
        provider: "gitlab",
        host: "gitlab.example.com",
        apiBase: "https://gitlab.example.com/api/v4",
        token: "T",
        httpsUser: "oauth2",
    } as GitHost,
};

// A scripted fetch: matches by "METHOD url-substring", records every call, answers with the scripted body.
const scriptedFetch = (script: Record<string, unknown>, calls: { method: string; url: string; body?: string }[]): FetchFn =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        const hit = Object.entries(script).find(([key]) => {
            const [wantMethod, fragment] = key.split(" ") as [string, string];
            return wantMethod === method && url.includes(fragment);
        });
        if (hit === undefined) {
            return new Response("not scripted", { status: 404 });
        }
        return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchFn;

test("status mapping collapses both vendors' vocabularies onto the six buckets", () => {
    expect(githubStatus("in_progress", null)).toBe("running");
    expect(githubStatus("completed", "success")).toBe("success");
    expect(githubStatus("completed", "failure")).toBe("failed");
    expect(githubStatus("completed", "timed_out")).toBe("failed");
    expect(githubStatus("completed", "cancelled")).toBe("canceled");
    expect(githubStatus("completed", "neutral")).toBe("skipped");
    expect(gitlabStatus("running")).toBe("running");
    expect(gitlabStatus("success")).toBe("success");
    expect(gitlabStatus("failed")).toBe("failed");
    expect(gitlabStatus("canceled")).toBe("canceled");
    expect(gitlabStatus("skipped")).toBe("skipped");
});

test("waiting for a runner is queued, not running", () => {
    for (const status of ["queued", "waiting", "requested", "pending"]) {
        expect(githubStatus(status, null)).toBe("queued");
    }
    for (const status of ["created", "waiting_for_resource", "preparing", "pending", "manual", "scheduled"]) {
        expect(gitlabStatus(status)).toBe("queued");
    }
    expect(githubStatus("some_new_phase", null)).toBe("running");
    expect(gitlabStatus("some_new_phase")).toBe("running");
});

test("a queued run carries no duration: the span since it was queued is a wait, not work", () => {
    const run = githubRun(githubProject, {
        id: 9,
        head_branch: "main",
        head_sha: "abc1234def",
        status: "queued",
        conclusion: null,
        html_url: "https://github.com/acme/web/actions/runs/9",
        created_at: "2026-07-29T10:00:00Z",
        run_started_at: "2026-07-29T10:00:00Z",
        // Actions reports queue wait via updated_at, not a separate field.
        updated_at: "2026-07-29T11:00:00Z",
    });
    expect(run.status).toBe("queued");
    expect(run.durationSeconds).toBeUndefined();
});

test("githubRun normalizes a workflow_run object: duration only once terminal", () => {
    const run = githubRun(githubProject, {
        id: 7,
        display_title: "fix: the thing",
        head_branch: "main",
        head_sha: "abc1234def",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/web/actions/runs/7",
        created_at: "2026-07-29T10:00:00Z",
        run_started_at: "2026-07-29T10:00:10Z",
        updated_at: "2026-07-29T10:02:10Z",
        actor: { login: "octocat", avatar_url: "https://avatars.github.com/u/1" },
    });
    expect(run).toMatchObject({
        repo: "web",
        host: "github",
        runId: 7,
        title: "fix: the thing",
        branch: "main",
        status: "failed",
        durationSeconds: 120,
        authorName: "octocat",
        authorAvatarUrl: "https://avatars.github.com/u/1",
    });
    const running = githubRun(githubProject, {
        id: 8,
        head_branch: "main",
        head_sha: "abc",
        status: "in_progress",
        conclusion: null,
        html_url: "u",
        created_at: "2026-07-29T10:00:00Z",
        updated_at: "2026-07-29T10:01:00Z",
    });
    expect(running.status).toBe("running");
    expect(running.durationSeconds).toBeUndefined();
    expect(running.title).toBeUndefined();
    expect(running.authorName).toBeUndefined();
    expect(running.authorAvatarUrl).toBeUndefined();
});

test("gitlabRun and gitlabHookRun normalize both pipeline shapes", () => {
    const listed = gitlabRun(gitlabProject, {
        id: 42,
        name: null,
        ref: "main",
        sha: "abc1234def",
        status: "success",
        web_url: "https://gitlab.example.com/group/app/-/pipelines/42",
        created_at: "2026-07-29T10:00:00Z",
        updated_at: "2026-07-29T10:03:00Z",
    });
    expect(listed).toMatchObject({ repo: "app", host: "gitlab", runId: 42, status: "success", durationSeconds: 180 });
    const hooked = gitlabHookRun(gitlabProject, {
        object_attributes: { id: 43, ref: "main", sha: "abc", status: "failed", created_at: "2026-07-29T10:00:00Z", duration: 95 },
        project: { path_with_namespace: "group/app", web_url: "https://gitlab.example.com/group/app" },
        commit: { title: "break the build" },
    });
    expect(hooked).toMatchObject({
        runId: 43,
        status: "failed",
        title: "break the build",
        durationSeconds: 95,
        url: "https://gitlab.example.com/group/app/-/pipelines/43",
    });
});

test("github client lists runs and reruns/cancels via the vendor endpoints", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor(
        "github",
        scriptedFetch(
            {
                "GET /actions/runs?": {
                    workflow_runs: [
                        {
                            id: 1,
                            head_branch: "main",
                            head_sha: "abc",
                            status: "completed",
                            conclusion: "success",
                            html_url: "u",
                            created_at: "2026-07-29T10:00:00Z",
                            updated_at: "2026-07-29T10:01:00Z",
                        },
                    ],
                },
                "POST /actions/runs/1/rerun": {},
                "POST /actions/runs/1/cancel": {},
            },
            calls,
        ),
    );
    const runs = await client.listRuns(githubProject, 5);
    expect(runs).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/web/actions/runs?per_page=5");
    await client.rerun(githubProject, 1);
    await client.cancel(githubProject, 1);
    await expect(client.rerun(githubProject, 2)).rejects.toThrow(/github rerun failed \(404\)/);
});

test("ensureHook is idempotent by delivery url; removeHook deletes exactly the matching hooks", async () => {
    const spec = { url: "https://sandbox.example.com/ci/webhook/github", secret: "S" };
    const creating: { method: string; url: string; body?: string }[] = [];
    await ciClientFor("github", scriptedFetch({ "GET /hooks": [], "POST /hooks": {} }, creating)).ensureHook(githubProject, spec);
    const created = creating.find((call) => call.method === "POST");
    expect(created?.body).toContain(spec.url);
    expect(created?.body).toContain("workflow_run");

    const existing: { method: string; url: string }[] = [];
    await ciClientFor("github", scriptedFetch({ "GET /hooks": [{ id: 9, config: { url: spec.url } }] }, existing)).ensureHook(githubProject, spec);
    expect(existing.some((call) => call.method === "POST")).toBe(false);

    const removing: { method: string; url: string }[] = [];
    await ciClientFor("github", scriptedFetch({ "GET /hooks": [{ id: 9, config: { url: spec.url } }], "DELETE /hooks/9": {} }, removing)).removeHook(
        githubProject,
        spec.url,
    );
    expect(removing.some((call) => call.method === "DELETE" && call.url.endsWith("/hooks/9"))).toBe(true);
});

const gitlabPipelines = [
    { id: 42, ref: "main", sha: "sha-a", status: "success", web_url: "u42", created_at: "2026-07-29T10:00:00Z", updated_at: "2026-07-29T10:03:00Z" },
    { id: 43, ref: "main", sha: "sha-b", status: "failed", web_url: "u43", created_at: "2026-07-29T11:00:00Z", updated_at: "2026-07-29T11:01:00Z" },
];

// Every job restates its pipeline's commit and user; one call dresses a whole page of runs.
const projectJob = (pipelineId: number, sha: string, title: string) => ({
    commit: { id: sha, title, author_name: "Ada Lovelace" },
    user: { name: "Ada Lovelace", username: "ada", avatar_url: "https://gitlab.example.com/avatar/ada.png" },
    pipeline: { id: pipelineId, source: "push" },
});

test("gitlab listRuns dresses a whole page from the single project jobs call", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor(
        "gitlab",
        scriptedFetch(
            {
                "GET /pipelines?": gitlabPipelines,
                "GET /jobs?": [
                    projectJob(42, "sha-a", "feat: draw the job graph"),
                    // Two jobs for pipeline 42: a repeat must not be re-derived as separate work.
                    projectJob(42, "sha-a", "feat: draw the job graph"),
                    projectJob(43, "sha-b", "fix: the build"),
                ],
            },
            calls,
        ),
    );
    const runs = await client.listRuns(gitlabProject, 15);
    expect(runs[0]).toMatchObject({
        runId: 42,
        title: "feat: draw the job graph",
        authorName: "Ada Lovelace",
        authorAvatarUrl: "https://gitlab.example.com/avatar/ada.png",
        trigger: "push",
    });
    expect(runs[1]).toMatchObject({ runId: 43, title: "fix: the build", authorName: "Ada Lovelace" });
    expect(calls.some((call) => call.url.includes("/repository/commits"))).toBe(false);
    expect(calls.filter((call) => call.url.includes("/jobs?")).length).toBe(1);
});

test("gitlab listRuns falls back to the commits join only for pipelines the jobs feed missed", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor(
        "gitlab",
        scriptedFetch(
            {
                "GET /pipelines?": gitlabPipelines,
                // Only pipeline 42 appears; 43 is older than the jobs page reaches.
                "GET /jobs?": [projectJob(42, "sha-a", "feat: draw the job graph")],
                "GET /repository/commits": [{ id: "sha-b", title: "fix: the build", author_name: "Grace Hopper" }],
            },
            calls,
        ),
    );
    const runs = await client.listRuns(gitlabProject, 15);
    expect(runs[0]).toMatchObject({ runId: 42, title: "feat: draw the job graph", authorAvatarUrl: "https://gitlab.example.com/avatar/ada.png" });
    expect(runs[1]).toMatchObject({ runId: 43, title: "fix: the build", authorName: "Grace Hopper" });
    expect(runs[1]?.authorAvatarUrl).toBeUndefined();
    expect(calls.some((call) => call.url.includes("/repository/commits?all=true"))).toBe(true);
});

test("gitlab listRuns still lists when both enrichments are refused", async () => {
    // Neither enrichment endpoint is scripted; unscripted calls answer 404 and the list must survive that.
    const runs = await ciClientFor("gitlab", scriptedFetch({ "GET /pipelines?": gitlabPipelines }, [])).listRuns(gitlabProject, 15);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ runId: 42, status: "success", branch: "main" });
    expect(runs[0]?.title).toBeUndefined();
    expect(runs[0]?.authorName).toBeUndefined();
    expect(runs[0]?.authorAvatarUrl).toBeUndefined();
});

test("gitlab client addresses the project by its url-encoded path", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const client = ciClientFor("gitlab", scriptedFetch({ "GET /hooks": [], "POST /hooks": {} }, calls));
    await client.ensureHook(gitlabProject, { url: "https://sandbox.example.com/ci/webhook/gitlab", secret: "S" });
    expect(calls[0]?.url).toContain("/projects/group%2Fapp/hooks");
    const created = calls.find((call) => call.method === "POST");
    expect(created?.body).toContain(`"pipeline_events":true`);
    expect(created?.body).toContain(`"token":"S"`);
});

// githubJobsFetch is its own stub: a workflow file is text, and the call shape (path, sha) matters.
const CI_YAML = `
jobs:
  preflight: {}
  verify-core:
    needs: preflight
    uses: ./.github/workflows/verify.yml
  release:
    needs: verify-core
`;

// The file verify-core calls via a reusable workflow; the only place naming what verify-core waited on.
const VERIFY_YAML = `
on:
  workflow_call:
jobs:
  verify: {}
`;

const githubJobsFetch = (options: { workflow?: string; runOk?: boolean }): { fetchFn: FetchFn; urls: string[] } => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/jobs?")) {
            const jobs = ["preflight", "verify-core / verify", "release"].map((name, index) => ({
                id: index,
                name,
                status: "completed",
                conclusion: "success",
                started_at: "2024-01-01T00:00:00Z",
                completed_at: "2024-01-01T00:01:00Z",
                html_url: null,
            }));
            return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/contents/")) {
            if (options.workflow === undefined) {
                return new Response("nope", { status: 404 });
            }
            // Per path: the run's workflow calls a second file, so both must resolve.
            return new Response(url.includes("verify.yml") ? VERIFY_YAML : options.workflow, { status: 200 });
        }
        if (options.runOk === false) {
            return new Response("nope", { status: 404 });
        }
        return new Response(JSON.stringify({ path: ".github/workflows/ci.yml", head_sha: "deadbee" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as FetchFn;
    return { fetchFn, urls };
};

test("github allJobs resolves needs from the run's own workflow file, pinned to the run's sha", async () => {
    const { fetchFn, urls } = githubJobsFetch({ workflow: CI_YAML });
    const jobs = await ciClientFor("github", fetchFn).allJobs(githubProject, 7);

    expect(jobs.map((job) => job.needs)).toEqual([[], ["preflight"], ["verify-core / verify"]]);
    // The reusable-workflow call reports its job under a name `needs` never mentions; `release` still resolves it.
    expect(jobs[1]?.name).toBe("verify-core / verify");
    // Pinned to the run's sha, not HEAD, for both files: an old run must be drawn from the graph it actually ran.
    expect(urls.some((url) => url.includes("/contents/.github/workflows/ci.yml?ref=deadbee"))).toBe(true);
    expect(urls.some((url) => url.includes("/contents/.github/workflows/verify.yml?ref=deadbee"))).toBe(true);
});

test("github allJobs still returns the jobs when the workflow file cannot be read", async () => {
    // Enrichment failure (no read access, deleted workflow) must not cost the caller the job list.
    for (const options of [{}, { runOk: false }]) {
        const jobs = await ciClientFor("github", githubJobsFetch(options).fetchFn).allJobs(githubProject, 7);
        expect(jobs).toHaveLength(3);
        expect(jobs.every((job) => job.needs === undefined)).toBe(true);
        expect(jobs[0]).toMatchObject({ name: "preflight", status: "success", durationSeconds: 60 });
    }
});

// Actions sets started_at to the run's queue time even for a job that never started; that value must not reach the view
// as an elapsed-time anchor.
test("github allJobs drops the started_at Actions reports for a job that never started", async () => {
    const queuedAt = "2026-09-05T07:15:42Z";
    const fetchFn = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/jobs?")) {
            const jobs = [
                { id: 1, name: "ci-audit", status: "completed", conclusion: "success", started_at: queuedAt, completed_at: "2026-09-05T07:17:31Z" },
                // Held for a self-hosted runner: never picked up, yet still handed a started_at.
                { id: 2, name: "e2e", status: "queued", conclusion: null, started_at: queuedAt, completed_at: null },
            ].map((job) => ({ ...job, html_url: null }));
            return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("nope", { status: 404 });
    }) as FetchFn;

    const [ran, waiting] = await ciClientFor("github", fetchFn).allJobs(githubProject, 7);
    expect(ran).toMatchObject({ name: "ci-audit", status: "success", startedAt: Date.parse(queuedAt), durationSeconds: 109 });
    expect(waiting?.status).toBe("queued");
    expect(waiting?.startedAt).toBeUndefined();
    expect(waiting?.durationSeconds).toBeUndefined();
});

// Runner logs carry ANSI color and self-overwriting progress lines, stripped because the tail is quoted into a prompt a
// model reads; both vendors carry them.
const logsFetch = (log: string): FetchFn =>
    (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/jobs?per_page=100")) {
            return new Response(JSON.stringify({ jobs: [{ id: 11, name: "verify", conclusion: "failure" }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (url.includes("/pipelines/7/jobs")) {
            return new Response(JSON.stringify([{ id: 11, name: "verify", status: "failed", stage: "test" }]), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        return new Response(log, { status: 200 });
    }) as FetchFn;

test("a failed job's log tail is plain text, not the runner's own bytes", async () => {
    const esc = String.fromCodePoint(0x1b);
    const log = `${esc}[31mFAIL${esc}[0m src/a.test.ts\ninstalling 1/2\rinstalling 2/2\n`;
    for (const provider of ["github", "gitlab"] as const) {
        const project = provider === "github" ? githubProject : gitlabProject;
        const logs = await ciClientFor(provider, logsFetch(log)).failedJobLogs(project, 7, 24_000);
        expect(logs).toBe("--- job: verify (log tail) ---\nFAIL src/a.test.ts\ninstalling 2/2\n");
    }
});
