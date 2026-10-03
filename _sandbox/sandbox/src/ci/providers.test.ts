import type { GitHost } from "../capabilities/cli/git-access.js";
import { ciClientFor, CiRateLimited, type FetchFn, githubRun, githubStatus, gitlabHookRun, gitlabRun, gitlabStatus } from "./providers.js";
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
        name: "CI",
    });
    expect(run).toMatchObject({
        repo: "web",
        host: "github",
        runId: 7,
        title: "fix: the thing",
        workflow: "CI",
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
    expect(JSON.parse(created?.body ?? "{}").events).toEqual(["workflow_run", "workflow_job"]);

    const existing: { method: string; url: string }[] = [];
    const wired = [{ id: 9, events: ["workflow_run", "workflow_job"], config: { url: spec.url } }];
    await ciClientFor("github", scriptedFetch({ "GET /hooks": wired }, existing)).ensureHook(githubProject, spec);
    expect(existing.map((call) => call.method)).toEqual(["GET"]);

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

// A hook registered before each job was heard on its own delivers finished runs only; it learns the job events in place,
// keeping its id, rather than being duplicated.
test("a hook that delivers only finished runs learns the job events, on both forges", async () => {
    const github: { method: string; url: string; body?: string }[] = [];
    const githubSpec = { url: "https://sandbox.example.com/ci/webhook/github", secret: "S" };
    await ciClientFor(
        "github",
        scriptedFetch({ "GET /hooks": [{ id: 9, events: ["workflow_run"], config: { url: githubSpec.url } }], "PATCH /hooks/9": {} }, github),
    ).ensureHook(githubProject, githubSpec);
    expect(github.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(JSON.parse(github[1]?.body ?? "{}")).toEqual({ add_events: ["workflow_job"] });

    const gitlab: { method: string; url: string; body?: string }[] = [];
    const gitlabSpec = { url: "https://sandbox.example.com/ci/webhook/gitlab", secret: "S" };
    await ciClientFor(
        "gitlab",
        scriptedFetch({ "GET /hooks": [{ id: 4, url: gitlabSpec.url, job_events: false }], "PUT /hooks/4": {} }, gitlab),
    ).ensureHook(gitlabProject, gitlabSpec);
    expect(gitlab.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(gitlab[1]?.body ?? "{}")).toMatchObject({ url: gitlabSpec.url, token: "S", pipeline_events: true, job_events: true });
});

test("a failed job names its id, the step that failed it, and gitlab's own reason; a gitlab job allowed to fail is none", async () => {
    const github = await ciClientFor(
        "github",
        scriptedFetch(
            {
                "GET /actions/runs/41/jobs": {
                    jobs: [
                        { id: 7, name: "verify-core", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] },
                        { id: 8, name: "lint", conclusion: "success", steps: [] },
                    ],
                },
            },
            [],
        ),
    ).failedSteps(githubProject, 41);
    expect(github).toEqual([{ job: "verify-core", id: 7, step: "Run tests", steps: ["Run tests"] }]);

    const gitlab = await ciClientFor(
        "gitlab",
        scriptedFetch(
            {
                "GET /pipelines/42/jobs": [
                    { id: 3, name: "test", allow_failure: false, failure_reason: "script_failure" },
                    { id: 4, name: "flaky-e2e", allow_failure: true, failure_reason: "script_failure" },
                ],
            },
            [],
        ),
    ).failedSteps(gitlabProject, 42);
    expect(gitlab).toEqual([{ job: "test", id: 3, reason: "script_failure" }]);
});

test("gitlab client addresses the project by its url-encoded path", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const client = ciClientFor("gitlab", scriptedFetch({ "GET /hooks": [], "POST /hooks": {} }, calls));
    await client.ensureHook(gitlabProject, { url: "https://sandbox.example.com/ci/webhook/gitlab", secret: "S" });
    expect(calls[0]?.url).toContain("/projects/group%2Fapp/hooks");
    const created = calls.find((call) => call.method === "POST");
    expect(created?.body).toContain(`"pipeline_events":true`);
    expect(created?.body).toContain(`"job_events":true`);
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

// A watched run is re-read every few seconds; its workflow files are fixed at its sha, so only the job list is fetched
// again. Without this a polled row would spend a vendor call per reusable workflow, per beat.
test("github allJobs reads the run's workflow source once, however often its jobs are re-read", async () => {
    const { fetchFn, urls } = githubJobsFetch({ workflow: CI_YAML });
    const client = ciClientFor("github", fetchFn);

    await client.allJobs(githubProject, 71);
    const afterFirst = urls.filter((url) => url.includes("/contents/")).length;
    const second = await client.allJobs(githubProject, 71);

    expect(afterFirst).toBeGreaterThan(0);
    expect(urls.filter((url) => url.includes("/contents/"))).toHaveLength(afterFirst);
    // Same graph as the first read: what was cached is the source, not the jobs.
    expect(second.map((job) => job.needs)).toEqual([[], ["preflight"], ["verify-core / verify"]]);
    expect(urls.filter((url) => url.includes("/jobs?"))).toHaveLength(2);
});

test("github allJobs still returns the jobs when the workflow file cannot be read", async () => {
    // Enrichment failure (no read access, deleted workflow) must not cost the caller the job list.
    // A run id each, since a resolved source is remembered per run.
    for (const [runId, options] of [
        [72, {}],
        [73, { runOk: false }],
    ] as const) {
        const jobs = await ciClientFor("github", githubJobsFetch(options).fetchFn).allJobs(githubProject, runId);
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

    const [ran, waiting] = await ciClientFor("github", fetchFn).allJobs(githubProject, 74);
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

test("a failed job's log is plain text, not the runner's own bytes, and read whole unless asked for its end", async () => {
    const esc = String.fromCodePoint(0x1b);
    const log = `${esc}[31mFAIL${esc}[0m src/a.test.ts\ninstalling 1/2\rinstalling 2/2\n`;
    for (const provider of ["github", "gitlab"] as const) {
        const project = provider === "github" ? githubProject : gitlabProject;
        const client = ciClientFor(provider, logsFetch(log));
        expect(await client.jobLog(project, 11, Number.POSITIVE_INFINITY)).toBe("FAIL src/a.test.ts\ninstalling 2/2\n");
        expect(await client.jobLog(project, 11, 15)).toBe("installing 2/2\n");
    }
});

// A Fix press waits on its run's job list before any agent exists, and the board's row read that list moments before to
// draw its stage circles. A settled run's list is the one the press takes; a list still moving, or one a re-run made
// stale, goes out again.
const listCalls = (calls: readonly { url: string }[]): number => calls.filter(({ url }) => url.includes("/jobs?")).length;

const githubSettledJobs = (status: string) => ({
    "GET /actions/runs/": {
        jobs: [
            { id: 7, name: "verify-core", status: "completed", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] },
            { id: 8, name: "lint", status, conclusion: status === "completed" ? "success" : null },
        ].map((job) => ({ started_at: null, completed_at: null, html_url: null, ...job })),
    },
    "GET /actions/jobs/7/logs": "FAIL src/a.test.ts",
});

test("a fix takes the settled job list the board's row just read, in one request however many ways it reads it", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor("github", scriptedFetch(githubSettledJobs("completed"), calls));
    await client.allJobs(githubProject, 81);

    const [jobs, steps] = await Promise.all([client.failedJobs(githubProject, 81), client.failedSteps(githubProject, 81)]);

    expect({ jobs, steps }).toEqual({
        jobs: ["verify-core"],
        steps: [{ job: "verify-core", id: 7, step: "Run tests", steps: ["Run tests"] }],
    });
    expect(listCalls(calls)).toBe(1);
    // The board's own read is never the kept copy: its graph is always the vendor's word.
    await client.allJobs(githubProject, 81);
    expect(listCalls(calls)).toBe(2);
});

test("a job list with a job still going is shared while out, then read again", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor("github", scriptedFetch(githubSettledJobs("in_progress"), calls));
    await Promise.all([client.failedJobs(githubProject, 82), client.failedSteps(githubProject, 82)]);
    expect(listCalls(calls)).toBe(1);

    await client.failedSteps(githubProject, 82);
    expect(listCalls(calls)).toBe(2);
});

test("a re-run from here forgets the job list kept for its run", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor("github", scriptedFetch({ ...githubSettledJobs("completed"), "POST /actions/runs/83/rerun": {} }, calls));
    await client.allJobs(githubProject, 83);
    await client.rerun(githubProject, 83);

    await client.failedSteps(githubProject, 83);
    expect(listCalls(calls)).toBe(2);
});

test("a gitlab fix reads its failed jobs once for all three readings, and never keeps them", async () => {
    const calls: { method: string; url: string }[] = [];
    const client = ciClientFor(
        "gitlab",
        scriptedFetch({ "GET /pipelines/84/jobs": [{ id: 3, name: "test", failure_reason: "script_failure" }], "GET /jobs/3/trace": "FAIL" }, calls),
    );
    await Promise.all([client.failedJobs(gitlabProject, 84), client.failedSteps(gitlabProject, 84)]);
    expect(listCalls(calls)).toBe(1);

    await client.failedSteps(gitlabProject, 84);
    expect(listCalls(calls)).toBe(2);
});

// The rate-limit refusal a call ended in; anything else fails the test with what it was.
const limitedBy = async (call: Promise<unknown>): Promise<CiRateLimited> => {
    try {
        await call;
    } catch (error) {
        if (error instanceof CiRateLimited) {
            return error;
        }
        throw error;
    }
    throw new Error("the call was not refused");
};

// GitHub answers a spent limit with the 403 a token without rights gets too; only its headers tell them apart.
test("a spent rate limit is a typed refusal carrying when it lifts, and the account is not asked again until then", async () => {
    const lifts = Date.now() + 3_600_000;
    let asked = 0;
    // SAFETY: the client calls its transport with (url, init) only, which this answers whatever they are.
    const limited = (async () => {
        asked += 1;
        return new Response(`{"message":"API rate limit exceeded"}`, {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(lifts / 1000)) },
        });
    }) as FetchFn;
    const client = ciClientFor("github", limited);
    expect((await limitedBy(client.listRuns(githubProject, 5))).until).toBe(Math.floor(lifts / 1000) * 1000);
    // The poller, the hook reconcile and the board's backfill all go through this client: none of them asks.
    await expect(ciClientFor("github", limited).ensureHook(githubProject, { url: "https://x/ci/webhook/github", secret: "s" })).rejects.toBeInstanceOf(
        CiRateLimited,
    );
    expect(asked).toBe(1);
});

test("a 403 that is not a rate limit stays a refusal, and a 429's Retry-After is when the limit lifts", async () => {
    // SAFETY: as above, the transport is called with (url, init) only.
    const forbidden = (async () => new Response(`{"message":"Resource not accessible"}`, { status: 403 })) as FetchFn;
    await expect(ciClientFor("github", forbidden).listRuns(githubProject, 5)).rejects.toThrow("github runs list failed (403)");
    await expect(ciClientFor("github", forbidden).listRuns(githubProject, 5)).rejects.not.toBeInstanceOf(CiRateLimited);

    const before = Date.now();
    // SAFETY: as above.
    const busy = (async () => new Response("Retry later", { status: 429, headers: { "retry-after": "120" } })) as FetchFn;
    const { until } = await limitedBy(ciClientFor("gitlab", busy).listRuns(gitlabProject, 5));
    // Bounded by the two clock reads around the call: the 120 s is counted from when the answer came.
    expect(until).toBeGreaterThanOrEqual(before + 120_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 120_000);
});

test("a repository's id, path and default branch are the forge's own word, on both forges", async () => {
    const calls: { method: string; url: string }[] = [];
    const github = ciClientFor(
        "github",
        scriptedFetch({ "GET /repos/acme/web": { id: 99, full_name: "acme/web-next", default_branch: "develop" } }, calls),
    );
    expect(await github.repository(githubProject)).toEqual({ id: 99, path: "acme/web-next", defaultBranch: "develop" });
    const gitlab = ciClientFor(
        "gitlab",
        scriptedFetch({ "GET /projects/group%2Fapp": { id: 7, path_with_namespace: "group/app", default_branch: null } }, calls),
    );
    expect(await gitlab.repository(gitlabProject)).toEqual({ id: 7, path: "group/app", defaultBranch: undefined });
    expect(calls.map(({ url }) => url)).toEqual(["https://api.github.com/repos/acme/web", "https://gitlab.example.com/api/v4/projects/group%2Fapp"]);
});
