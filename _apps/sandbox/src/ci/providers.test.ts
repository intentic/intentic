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

test("githubRun normalizes a workflow_run object — duration only once terminal", () => {
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
    });
    expect(run).toMatchObject({
        repo: "web",
        host: "github",
        runId: 7,
        title: "fix: the thing",
        branch: "main",
        status: "failed",
        durationSeconds: 120,
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

test("gitlab client addresses the project by its url-encoded path", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const client = ciClientFor("gitlab", scriptedFetch({ "GET /hooks": [], "POST /hooks": {} }, calls));
    await client.ensureHook(gitlabProject, { url: "https://sandbox.example.com/ci/webhook/gitlab", secret: "S" });
    expect(calls[0]?.url).toContain("/projects/group%2Fapp/hooks");
    const created = calls.find((call) => call.method === "POST");
    expect(created?.body).toContain(`"pipeline_events":true`);
    expect(created?.body).toContain(`"token":"S"`);
});
