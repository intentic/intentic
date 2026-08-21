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

// A scripted fetch: match by "METHOD url-substring", record every call, answer with the scripted body.
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

test("status mapping collapses both vendors' vocabularies onto the five buckets", () => {
    expect(githubStatus("in_progress", null)).toBe("running");
    expect(githubStatus("completed", "success")).toBe("success");
    expect(githubStatus("completed", "failure")).toBe("failed");
    expect(githubStatus("completed", "timed_out")).toBe("failed");
    expect(githubStatus("completed", "cancelled")).toBe("canceled");
    expect(githubStatus("completed", "neutral")).toBe("skipped");
    expect(gitlabStatus("running")).toBe("running");
    expect(gitlabStatus("manual")).toBe("running");
    expect(gitlabStatus("success")).toBe("success");
    expect(gitlabStatus("failed")).toBe("failed");
    expect(gitlabStatus("canceled")).toBe("canceled");
    expect(gitlabStatus("skipped")).toBe("skipped");
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
    // A vendor refusal surfaces with its status and words.
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

// The project-wide jobs feed: every job restates its pipeline's commit and triggering user, which is how one
// call dresses a whole page of runs.
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
                    // A second job of the same pipeline must not re-derive anything.
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
    // The whole page was covered, so the commits fallback must never be reached.
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
                // Only pipeline 42 appears: 43 is older than the jobs page reaches.
                "GET /jobs?": [projectJob(42, "sha-a", "feat: draw the job graph")],
                "GET /repository/commits": [{ id: "sha-b", title: "fix: the build", author_name: "Grace Hopper" }],
            },
            calls,
        ),
    );
    const runs = await client.listRuns(gitlabProject, 15);
    // Covered by the jobs feed: keeps its avatar.
    expect(runs[0]).toMatchObject({ runId: 42, title: "feat: draw the job graph", authorAvatarUrl: "https://gitlab.example.com/avatar/ada.png" });
    // Recovered by the fallback: subject and author, but no avatar to be had from a commit.
    expect(runs[1]).toMatchObject({ runId: 43, title: "fix: the build", authorName: "Grace Hopper" });
    expect(runs[1]?.authorAvatarUrl).toBeUndefined();
    expect(calls.some((call) => call.url.includes("/repository/commits?all=true"))).toBe(true);
});

test("gitlab listRuns still lists when both enrichments are refused", async () => {
    // Neither enrichment endpoint is scripted, so both answer 404: the run list must survive that.
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

/* The job graph's enrichment. `scriptedFetch` answers JSON, and a workflow file is text, so these use their
   own two-endpoint stub, which also makes the CALL SHAPE visible, since the point of fetching the run first
   is to learn the path and sha the contents call needs. */
const CI_YAML = `
jobs:
  preflight: {}
  verify-core:
    needs: preflight
    uses: ./.github/workflows/verify.yml
  release:
    needs: verify-core
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
            return options.workflow === undefined ? new Response("nope", { status: 404 }) : new Response(options.workflow, { status: 200 });
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
    // The reusable-workflow call reported one job under a name `needs` never mentions; `release` still reaches it.
    expect(jobs[1]?.name).toBe("verify-core / verify");
    // The sha, not HEAD: an old run must be drawn with the graph it actually ran.
    expect(urls.some((url) => url.includes("/contents/.github/workflows/ci.yml?ref=deadbee"))).toBe(true);
});

test("github allJobs still returns the jobs when the workflow file cannot be read", async () => {
    // A token without `contents`, a deleted workflow, a run owned by another repo's reusable workflow. The
    // graph is an enrichment; losing it must not cost the caller the job list.
    for (const options of [{}, { runOk: false }]) {
        const jobs = await ciClientFor("github", githubJobsFetch(options).fetchFn).allJobs(githubProject, 7);
        expect(jobs).toHaveLength(3);
        expect(jobs.every((job) => job.needs === undefined)).toBe(true);
        expect(jobs[0]).toMatchObject({ name: "preflight", status: "success", durationSeconds: 60 });
    }
});

/* THE FIX CONVERSATION'S EVIDENCE. A runner prints for a terminal: a coloured verdict, a progress line that
 * rewrites itself, and this log tail is quoted into a prompt the user edits and a model reads, where those
 * bytes are litter with the failure buried in it. Both vendors, because both traces carry them. */
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
