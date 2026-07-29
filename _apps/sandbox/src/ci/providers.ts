import type { PipelineRun, PipelineStatus } from "@intentic/sandbox-contract";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import type { CiProject } from "./projects.js";

/* The two vendors' pipeline APIs behind one client shape, keyed off the account a project mapped to
 * (projects.ts). Everything the CI surface does — the view's run list, rerun/cancel, the fix context's log
 * tails, and the webhook reconciler's hook CRUD — goes through here, so the vendor branch exists exactly once.
 * `fetch` is injectable for tests (the git-access GitAccessDeps precedent); failures throw with the vendor's
 * status + body tail and the caller decides what a failure means. */

export type FetchFn = typeof fetch;

// What the reconciler asks a vendor to deliver to: the daemon's public receiver + the per-sandbox secret
// (github signs with it, gitlab echoes it as X-Gitlab-Token).
export interface HookSpec {
    readonly url: string;
    readonly secret: string;
}

export interface CiClient {
    // Newest-first recent runs, normalized. `failedJobs` is NOT filled here — list calls are the hot path.
    readonly listRuns: (project: CiProject, limit: number) => Promise<PipelineRun[]>;
    // Names of the run's failed jobs — the one-extra-call enrichment for failed runs.
    readonly failedJobs: (project: CiProject, runId: number) => Promise<string[]>;
    // The failed jobs' log tails, concatenated and capped — the fix conversation's context.
    readonly failedJobLogs: (project: CiProject, runId: number, maxBytes: number) => Promise<string>;
    readonly rerun: (project: CiProject, runId: number) => Promise<void>;
    readonly cancel: (project: CiProject, runId: number) => Promise<void>;
    // Idempotent: a hook already delivering to spec.url is left alone, otherwise one is created.
    readonly ensureHook: (project: CiProject, spec: HookSpec) => Promise<void>;
    // Best-effort inverse, matched by delivery url (the KEY_TITLE-style fixed identity).
    readonly removeHook: (project: CiProject, url: string) => Promise<void>;
    readonly projectUrl: (project: CiProject) => string;
}

const BODY_TAIL = 300;

const throwOn = async (response: Response, what: string): Promise<Response> => {
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${what} failed (${response.status}): ${body.slice(0, BODY_TAIL)}`);
    }
    return response;
};

const json = async <T>(response: Response, what: string): Promise<T> => (await throwOn(response, what)).json() as Promise<T>;

const epoch = (iso: string | undefined | null): number => {
    const parsed = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
    return Number.isNaN(parsed) ? 0 : parsed;
};

// ---- github: Actions workflow runs ----

// status ≠ "completed" is every in-flight shape (queued, in_progress, waiting, pending, requested); a completed
// run's conclusion fans out into the three terminal buckets, with everything that means "did not pass" —
// failure, timed_out, startup_failure, action_required — reading as failed.
export const githubStatus = (status: string, conclusion: string | null | undefined): PipelineStatus => {
    if (status !== "completed") {
        return "running";
    }
    switch (conclusion) {
        case "success":
            return "success";
        case "cancelled":
            return "canceled";
        case "skipped":
        case "neutral":
        case "stale":
            return "skipped";
        default:
            return "failed";
    }
};

export interface GithubRun {
    readonly id: number;
    readonly display_title?: string;
    readonly head_branch: string | null;
    readonly head_sha: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly html_url: string;
    readonly created_at: string;
    readonly run_started_at?: string;
    readonly updated_at: string;
}

// One workflow_run object → the normalized run — shared verbatim by the list call and the webhook receiver
// (github's webhook carries the same object under `workflow_run`).
export const githubRun = (project: Pick<CiProject, "repo" | "project">, run: GithubRun): PipelineRun => {
    const status = githubStatus(run.status, run.conclusion);
    const started = epoch(run.run_started_at ?? run.created_at);
    const ended = epoch(run.updated_at);
    return {
        repo: project.repo,
        host: "github",
        project: project.project,
        runId: run.id,
        ...(run.display_title !== undefined && run.display_title !== "" ? { title: run.display_title } : {}),
        branch: run.head_branch ?? "",
        sha: run.head_sha,
        status,
        url: run.html_url,
        createdAt: epoch(run.created_at),
        ...(status !== "running" && ended > started ? { durationSeconds: Math.round((ended - started) / 1000) } : {}),
    };
};

const githubApi = (project: CiProject, path: string): string => `${project.account.apiBase}/repos/${project.project}${path}`;

const githubClient = (fetchFn: FetchFn): CiClient => {
    const post = async (project: CiProject, path: string, what: string, body?: object): Promise<void> => {
        await throwOn(
            await fetchFn(githubApi(project, path), {
                method: "POST",
                headers: { ...githubHeaders(project.account.token), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            }),
            what,
        );
    };
    const jobsOf = async (project: CiProject, runId: number): Promise<{ id: number; name: string; conclusion: string | null }[]> => {
        const listed = await json<{ jobs: { id: number; name: string; conclusion: string | null }[] }>(
            await fetchFn(githubApi(project, `/actions/runs/${runId}/jobs?per_page=100`), { headers: githubHeaders(project.account.token) }),
            "github jobs list",
        );
        return listed.jobs.filter((job) => job.conclusion !== null && githubStatus("completed", job.conclusion) === "failed");
    };
    return {
        listRuns: async (project, limit) => {
            const listed = await json<{ workflow_runs: GithubRun[] }>(
                await fetchFn(githubApi(project, `/actions/runs?per_page=${limit}`), { headers: githubHeaders(project.account.token) }),
                "github runs list",
            );
            return listed.workflow_runs.map((run) => githubRun(project, run));
        },
        failedJobs: async (project, runId) => (await jobsOf(project, runId)).map((job) => job.name),
        failedJobLogs: async (project, runId, maxBytes) => {
            const failed = await jobsOf(project, runId);
            const parts: string[] = [];
            let budget = maxBytes;
            for (const job of failed) {
                if (budget <= 0) {
                    break;
                }
                // The logs endpoint 302-redirects to a short-lived blob url; fetch follows it. A job whose log
                // is already expired shouldn't sink the whole context — skip it and say so.
                const response = await fetchFn(githubApi(project, `/actions/jobs/${job.id}/logs`), { headers: githubHeaders(project.account.token) });
                const text = response.ok ? await response.text() : `(log unavailable: ${response.status})`;
                const tail = text.slice(-budget);
                budget -= tail.length;
                parts.push(`--- job: ${job.name} (log tail) ---\n${tail}`);
            }
            return parts.join("\n\n");
        },
        rerun: (project, runId) => post(project, `/actions/runs/${runId}/rerun`, "github rerun"),
        cancel: (project, runId) => post(project, `/actions/runs/${runId}/cancel`, "github cancel"),
        ensureHook: async (project, spec) => {
            const hooks = await json<{ id: number; config?: { url?: string } }[]>(
                await fetchFn(githubApi(project, "/hooks"), { headers: githubHeaders(project.account.token) }),
                "github hooks list",
            );
            if (hooks.some((hook) => hook.config?.url === spec.url)) {
                return;
            }
            await post(project, "/hooks", "github hook create", {
                name: "web",
                active: true,
                events: ["workflow_run"],
                config: { url: spec.url, content_type: "json", secret: spec.secret },
            });
        },
        removeHook: async (project, url) => {
            const hooks = await json<{ id: number; config?: { url?: string } }[]>(
                await fetchFn(githubApi(project, "/hooks"), { headers: githubHeaders(project.account.token) }),
                "github hooks list",
            );
            for (const hook of hooks.filter((candidate) => candidate.config?.url === url)) {
                await throwOn(
                    await fetchFn(githubApi(project, `/hooks/${hook.id}`), { method: "DELETE", headers: githubHeaders(project.account.token) }),
                    "github hook delete",
                );
            }
        },
        projectUrl: (project) => `https://${project.account.host}/${project.project}`,
    };
};

// ---- gitlab: pipelines ----

// gitlab's single status string: three terminal states map straight across, `manual`/`scheduled` and every
// pre-run shape (created, waiting_for_resource, preparing, pending) read as still-moving.
export const gitlabStatus = (status: string): PipelineStatus => {
    switch (status) {
        case "success":
            return "success";
        case "failed":
            return "failed";
        case "canceled":
            return "canceled";
        case "skipped":
            return "skipped";
        default:
            return "running";
    }
};

interface GitlabPipeline {
    readonly id: number;
    readonly name?: string | null;
    readonly ref: string;
    readonly sha: string;
    readonly status: string;
    readonly web_url: string;
    readonly created_at: string;
    readonly updated_at?: string;
}

// One pipelines-list row → the normalized run. The list carries no duration; a terminal pipeline's
// created→updated span stands in (webhook events carry the true one and overwrite this in the cache).
export const gitlabRun = (project: Pick<CiProject, "repo" | "project">, pipeline: GitlabPipeline): PipelineRun => {
    const status = gitlabStatus(pipeline.status);
    const created = epoch(pipeline.created_at);
    const updated = epoch(pipeline.updated_at);
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: pipeline.id,
        ...(pipeline.name !== undefined && pipeline.name !== null && pipeline.name !== "" ? { title: pipeline.name } : {}),
        branch: pipeline.ref,
        sha: pipeline.sha,
        status,
        url: pipeline.web_url,
        createdAt: created,
        ...(status !== "running" && updated > created ? { durationSeconds: Math.round((updated - created) / 1000) } : {}),
    };
};

// The Pipeline Hook payload's shape differs from the list row's (attributes nested, the true duration and
// finished_at present, no web_url on older instances) — its own normalizer, sharing the status mapping.
export interface GitlabPipelineHook {
    readonly object_attributes: {
        readonly id: number;
        readonly name?: string | null;
        readonly ref: string;
        readonly sha: string;
        readonly status: string;
        readonly created_at: string;
        readonly duration?: number | null;
        readonly url?: string;
    };
    readonly project: { readonly path_with_namespace: string; readonly web_url: string };
    readonly commit?: { readonly title?: string };
    readonly user?: { readonly name?: string; readonly username?: string };
}

export const gitlabHookRun = (project: Pick<CiProject, "repo" | "project">, hook: GitlabPipelineHook): PipelineRun => {
    const attributes = hook.object_attributes;
    const title = attributes.name ?? hook.commit?.title;
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: attributes.id,
        ...(title !== undefined && title !== null && title !== "" ? { title } : {}),
        branch: attributes.ref,
        sha: attributes.sha,
        status: gitlabStatus(attributes.status),
        url: attributes.url ?? `${hook.project.web_url}/-/pipelines/${attributes.id}`,
        createdAt: epoch(attributes.created_at),
        ...(attributes.duration !== undefined && attributes.duration !== null ? { durationSeconds: attributes.duration } : {}),
    };
};

const gitlabApi = (project: CiProject, path: string): string => `${project.account.apiBase}/projects/${encodeURIComponent(project.project)}${path}`;
const gitlabHeaders = (project: CiProject): Record<string, string> => ({ "PRIVATE-TOKEN": project.account.token });

const gitlabClient = (fetchFn: FetchFn): CiClient => {
    const post = async (project: CiProject, path: string, what: string, body?: object): Promise<void> => {
        await throwOn(
            await fetchFn(gitlabApi(project, path), {
                method: "POST",
                headers: { ...gitlabHeaders(project), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            }),
            what,
        );
    };
    const failedJobsOf = async (project: CiProject, runId: number): Promise<{ id: number; name: string }[]> =>
        json<{ id: number; name: string }[]>(
            await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?scope[]=failed&per_page=100`), { headers: gitlabHeaders(project) }),
            "gitlab jobs list",
        );
    return {
        listRuns: async (project, limit) => {
            const listed = await json<GitlabPipeline[]>(
                await fetchFn(gitlabApi(project, `/pipelines?per_page=${limit}`), { headers: gitlabHeaders(project) }),
                "gitlab pipelines list",
            );
            return listed.map((pipeline) => gitlabRun(project, pipeline));
        },
        failedJobs: async (project, runId) => (await failedJobsOf(project, runId)).map((job) => job.name),
        failedJobLogs: async (project, runId, maxBytes) => {
            const failed = await failedJobsOf(project, runId);
            const parts: string[] = [];
            let budget = maxBytes;
            for (const job of failed) {
                if (budget <= 0) {
                    break;
                }
                const response = await fetchFn(gitlabApi(project, `/jobs/${job.id}/trace`), { headers: gitlabHeaders(project) });
                const text = response.ok ? await response.text() : `(log unavailable: ${response.status})`;
                const tail = text.slice(-budget);
                budget -= tail.length;
                parts.push(`--- job: ${job.name} (log tail) ---\n${tail}`);
            }
            return parts.join("\n\n");
        },
        rerun: (project, runId) => post(project, `/pipelines/${runId}/retry`, "gitlab retry"),
        cancel: (project, runId) => post(project, `/pipelines/${runId}/cancel`, "gitlab cancel"),
        ensureHook: async (project, spec) => {
            const hooks = await json<{ id: number; url: string }[]>(
                await fetchFn(gitlabApi(project, "/hooks"), { headers: gitlabHeaders(project) }),
                "gitlab hooks list",
            );
            if (hooks.some((hook) => hook.url === spec.url)) {
                return;
            }
            await post(project, "/hooks", "gitlab hook create", {
                url: spec.url,
                token: spec.secret,
                pipeline_events: true,
                push_events: false,
                enable_ssl_verification: true,
            });
        },
        removeHook: async (project, url) => {
            const hooks = await json<{ id: number; url: string }[]>(
                await fetchFn(gitlabApi(project, "/hooks"), { headers: gitlabHeaders(project) }),
                "gitlab hooks list",
            );
            for (const hook of hooks.filter((candidate) => candidate.url === url)) {
                await throwOn(
                    await fetchFn(gitlabApi(project, `/hooks/${hook.id}`), { method: "DELETE", headers: gitlabHeaders(project) }),
                    "gitlab hook delete",
                );
            }
        },
        projectUrl: (project) => `${project.account.apiBase.replace(/\/api\/v4$/, "")}/${project.project}`,
    };
};

export const ciClientFor = (host: "github" | "gitlab", fetchFn: FetchFn = fetch): CiClient =>
    host === "github" ? githubClient(fetchFn) : gitlabClient(fetchFn);
