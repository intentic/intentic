import { isPipelineInFlight, type PipelineJob, type PipelineRun, type PipelineStatus } from "@intentic/sandbox-contract";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import { plainText } from "@intentic/base/plain-text";
import type { CiProject } from "./projects.js";
import { localWorkflowCalls, resolveNeeds } from "./workflowGraph.js";

// Both vendors' pipeline APIs behind one client shape (CiClient), keyed off the account a project mapped to; the vendor
// branch exists exactly once. `fetch` is injectable for tests; failures throw with the vendor's status and body tail.

export type FetchFn = typeof fetch;

// Delivery target: the daemon's public receiver plus the signing secret (github signs with it, gitlab echoes it as
// X-Gitlab-Token).
export interface HookSpec {
    readonly url: string;
    readonly secret: string;
}

export interface CiClient {
    // Newest-first normalized runs; failedJobs is not filled here, list calls are the hot path.
    readonly listRuns: (project: CiProject, limit: number) => Promise<PipelineRun[]>;
    // Names of the run's failed jobs, the one-extra-call enrichment for failed runs.
    readonly failedJobs: (project: CiProject, runId: number) => Promise<string[]>;
    // All jobs in a run with their individual statuses, the expanded-row enrichment for the view.
    readonly allJobs: (project: CiProject, runId: number) => Promise<PipelineJob[]>;
    // Failed jobs' log tails, concatenated and capped; each is reduced to plain text (plain-text.ts) first.
    readonly failedJobLogs: (project: CiProject, runId: number, maxBytes: number) => Promise<string>;
    readonly rerun: (project: CiProject, runId: number) => Promise<void>;
    readonly cancel: (project: CiProject, runId: number) => Promise<void>;
    // Idempotent: a hook already delivering to spec.url is left alone, otherwise one is created.
    readonly ensureHook: (project: CiProject, spec: HookSpec) => Promise<void>;
    // Best-effort inverse; a hook is identified by its delivery url alone.
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

// Whether a run/job is over; only then is the span between its timestamps a duration, not elapsed-so-far or queue wait.
const isSettled = (status: PipelineStatus): boolean => !isPipelineInFlight(status);

// ---- github: Actions workflow runs ----

// Pre-run states (accepted, not yet executing); an unrecognized non-terminal status reads as running.
const GITHUB_QUEUED = new Set(["queued", "waiting", "requested", "pending"]);

// A completed run's conclusion maps to the three terminal buckets; anything meaning "did not pass" (failure, timed_out,
// startup_failure, action_required) reads as failed.
export const githubStatus = (status: string, conclusion: string | null | undefined): PipelineStatus => {
    if (status !== "completed") {
        return GITHUB_QUEUED.has(status) ? "queued" : "running";
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
    // Who set the run off; present on the runs list and the webhook, so the avatar costs no extra call.
    readonly actor?: { readonly login?: string; readonly avatar_url?: string } | null;
    // push | pull_request | schedule | workflow_dispatch | …
    readonly event?: string;
}

// One workflow_run object -> the normalized run; shared by the list call and the webhook receiver (same object under
// `workflow_run`).
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
        ...(run.actor?.login !== undefined && run.actor.login !== "" ? { authorName: run.actor.login } : {}),
        ...(run.actor?.avatar_url !== undefined && run.actor.avatar_url !== "" ? { authorAvatarUrl: run.actor.avatar_url } : {}),
        ...(run.event !== undefined && run.event !== "" ? { trigger: run.event } : {}),
        branch: run.head_branch ?? "",
        sha: run.head_sha,
        status,
        url: run.html_url,
        createdAt: epoch(run.created_at),
        ...(isSettled(status) && ended > started ? { durationSeconds: Math.round((ended - started) / 1000) } : {}),
    };
};

const githubApi = (project: CiProject, path: string): string => `${project.account.apiBase}/repos/${project.project}${path}`;

const githubClient = (fetchFn: FetchFn): CiClient => {
    // Resolves the run's workflow file at its exact sha, not HEAD, so an old run isn't drawn with the wrong graph.
    // Undefined, never a throw, for any legitimate empty case; the graph is enrichment only.
    const fileAt = async (project: CiProject, path: string, ref: string): Promise<string | undefined> => {
        // `.raw` hands back the file itself; the default json media type would wrap it in base64.
        const file = await fetchFn(githubApi(project, `/contents/${path}?ref=${ref}`), {
            headers: { ...githubHeaders(project.account.token), Accept: "application/vnd.github.raw" },
        });
        return file.ok ? await file.text() : undefined;
    };
    const workflowSource = async (project: CiProject, runId: number): Promise<{ root: string; called: Map<string, string> } | undefined> => {
        const runResponse = await fetchFn(githubApi(project, `/actions/runs/${runId}`), { headers: githubHeaders(project.account.token) });
        if (!runResponse.ok) {
            return undefined;
        }
        const run = (await runResponse.json()) as { path?: string; head_sha?: string };
        const ref = run.head_sha;
        if (run.path === undefined || ref === undefined) {
            return undefined;
        }
        const root = await fileAt(project, run.path, ref);
        if (root === undefined) {
            return undefined;
        }
        const called = new Map<string, string>();
        const asked = new Set([run.path]);
        let frontier = localWorkflowCalls(root);
        while (frontier.length > 0) {
            const wanted = [...new Set(frontier)].filter((path) => !asked.has(path));
            for (const path of wanted) {
                asked.add(path);
            }
            const fetched = await Promise.all(wanted.map(async (path) => [path, await fileAt(project, path, ref)] as const));
            frontier = [];
            for (const [path, source] of fetched) {
                if (source !== undefined) {
                    called.set(path, source);
                    frontier.push(...localWorkflowCalls(source));
                }
            }
        }
        return { root, called };
    };
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
        // No `stage`: Actions has no such concept. `needs` is filled only when the run's workflow file can be read,
        // fetched alongside the job list, not after; unreadable, jobs go out as before.
        allJobs: async (project, runId) => {
            const [listed, workflow] = await Promise.all([
                json<{
                    jobs: {
                        id: number;
                        name: string;
                        status: string;
                        conclusion: string | null;
                        started_at: string | null;
                        completed_at: string | null;
                        html_url: string | null;
                    }[];
                }>(
                    await fetchFn(githubApi(project, `/actions/runs/${runId}/jobs?per_page=100`), { headers: githubHeaders(project.account.token) }),
                    "github all jobs",
                ),
                workflowSource(project, runId),
            ]);
            const needs =
                workflow === undefined
                    ? undefined
                    : resolveNeeds(
                          workflow.root,
                          listed.jobs.map((job) => job.name),
                          workflow.called,
                      );
            return listed.jobs.map((job) => {
                const status = githubStatus(job.status, job.conclusion);
                const started = epoch(job.started_at);
                const completed = epoch(job.completed_at);
                const result: PipelineJob = { name: job.name, status };
                const declared = needs?.get(job.name);
                if (declared !== undefined) {
                    result.needs = declared;
                }
                if (job.html_url !== null) {
                    result.webUrl = job.html_url;
                }
                // started_at on a queued job is the run's queue time, not its own; drop it to avoid a false duration.
                if (started > 0 && status !== "queued") {
                    result.startedAt = started;
                }
                if (completed > 0) {
                    result.finishedAt = completed;
                }
                if (isSettled(status) && completed > started) {
                    result.durationSeconds = Math.round((completed - started) / 1000);
                }
                return result;
            });
        },
        failedJobLogs: async (project, runId, maxBytes) => {
            const failed = await jobsOf(project, runId);
            const parts: string[] = [];
            let budget = maxBytes;
            for (const job of failed) {
                if (budget <= 0) {
                    break;
                }
                // Redirects to a short-lived blob url; fetch follows it. An expired log is reported inline, not fatal.
                const response = await fetchFn(githubApi(project, `/actions/jobs/${job.id}/logs`), { headers: githubHeaders(project.account.token) });
                const text = response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`;
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

// Pre-run states, including manual/scheduled (waiting on a person or clock); unrecognized reads as running.
const GITLAB_QUEUED = new Set(["created", "waiting_for_resource", "preparing", "pending", "manual", "scheduled"]);

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
            return GITLAB_QUEUED.has(status) ? "queued" : "running";
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
    // push | schedule | merge_request_event | web | api | trigger | …
    readonly source?: string;
}

// A pipelines-list row names neither its commit nor its author; listRuns joins both in from responses the vendor
// already returns.
export interface GitlabRunMeta {
    readonly title?: string;
    readonly authorName?: string;
    readonly authorAvatarUrl?: string;
    readonly trigger?: string;
}

// One pipelines-list row -> the normalized run; duration is the created-to-updated span (queue time included) until a
// webhook overwrites it with the true one. `meta` is optional; absent still yields a valid run.
export const gitlabRun = (project: Pick<CiProject, "repo" | "project">, pipeline: GitlabPipeline, meta: GitlabRunMeta = {}): PipelineRun => {
    const status = gitlabStatus(pipeline.status);
    const created = epoch(pipeline.created_at);
    const updated = epoch(pipeline.updated_at);
    // A named pipeline takes priority; fall back to the commit subject only when unnamed.
    const title = pipeline.name !== undefined && pipeline.name !== null && pipeline.name !== "" ? pipeline.name : meta.title;
    const trigger = pipeline.source ?? meta.trigger;
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: pipeline.id,
        ...(title !== undefined && title !== "" ? { title } : {}),
        ...(meta.authorName !== undefined && meta.authorName !== "" ? { authorName: meta.authorName } : {}),
        ...(meta.authorAvatarUrl !== undefined && meta.authorAvatarUrl !== "" ? { authorAvatarUrl: meta.authorAvatarUrl } : {}),
        ...(trigger !== undefined && trigger !== "" ? { trigger } : {}),
        branch: pipeline.ref,
        sha: pipeline.sha,
        status,
        url: pipeline.web_url,
        createdAt: created,
        ...(isSettled(status) && updated > created ? { durationSeconds: Math.round((updated - created) / 1000) } : {}),
    };
};

// Pipeline Hook payload shape differs from the list row (attributes nested, true duration present, no web_url on older
// instances); its own normalizer shares the status mapping.
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
    // The hook is the one gitlab path that hands us an avatar outright, no /avatar lookup needed.
    readonly user?: { readonly name?: string; readonly username?: string; readonly avatar_url?: string };
}

export const gitlabHookRun = (project: Pick<CiProject, "repo" | "project">, hook: GitlabPipelineHook): PipelineRun => {
    const attributes = hook.object_attributes;
    const title = attributes.name ?? hook.commit?.title;
    const author = hook.user?.name ?? hook.user?.username;
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: attributes.id,
        ...(title !== undefined && title !== null && title !== "" ? { title } : {}),
        ...(author !== undefined && author !== "" ? { authorName: author } : {}),
        ...(hook.user?.avatar_url !== undefined && hook.user.avatar_url !== "" ? { authorAvatarUrl: hook.user.avatar_url } : {}),
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

// Jobs scanned to backfill commit+author for a page of pipelines; a busy repo still needs the commits fallback.
const GITLAB_JOB_SCAN = 100;
// How far back the fallback commit join reaches when the jobs feed didn't cover everything.
const GITLAB_COMMIT_SCAN = 100;

// One row of the project-wide jobs feed, narrowed to what a run headline needs.
interface GitlabProjectJob {
    readonly commit?: { readonly title?: string; readonly author_name?: string };
    readonly user?: { readonly name?: string; readonly username?: string; readonly avatar_url?: string };
    readonly pipeline?: { readonly id?: number; readonly source?: string };
}

interface GitlabCommit {
    readonly id: string;
    readonly title?: string;
    readonly author_name?: string;
}

const gitlabClient = (fetchFn: FetchFn): CiClient => {
    // Enrichment never fails the listing; every catch here is a deliberate swallow, not a rethrow.
    const metaFromJobs = async (project: CiProject): Promise<Map<number, GitlabRunMeta>> => {
        const byPipeline = new Map<number, GitlabRunMeta>();
        try {
            const jobs = await json<GitlabProjectJob[]>(
                await fetchFn(gitlabApi(project, `/jobs?per_page=${GITLAB_JOB_SCAN}`), { headers: gitlabHeaders(project) }),
                "gitlab project jobs",
            );
            for (const job of jobs) {
                const id = job.pipeline?.id;
                // First job wins: they all describe the same pipeline, so re-deriving per job buys nothing.
                if (id === undefined || byPipeline.has(id)) {
                    continue;
                }
                // Triggering user, not author: both UIs credit it, with a real avatar, not a gravatar guess.
                const author = job.user?.name ?? job.user?.username;
                byPipeline.set(id, {
                    ...(job.commit?.title !== undefined ? { title: job.commit.title } : {}),
                    ...(author !== undefined ? { authorName: author } : {}),
                    ...(job.user?.avatar_url !== undefined ? { authorAvatarUrl: job.user.avatar_url } : {}),
                    ...(job.pipeline?.source !== undefined ? { trigger: job.pipeline.source } : {}),
                });
            }
        } catch {
            return byPipeline;
        }
        return byPipeline;
    };

    // Fallback for pipelines the jobs feed missed; one call for subject+author, no avatar, issued only when something
    // came back bare. `all` sweeps every ref, so a side-branch pipeline resolves too.
    const commitsBySha = async (project: CiProject): Promise<Map<string, GitlabCommit>> => {
        try {
            const commits = await json<GitlabCommit[]>(
                await fetchFn(gitlabApi(project, `/repository/commits?all=true&per_page=${GITLAB_COMMIT_SCAN}`), { headers: gitlabHeaders(project) }),
                "gitlab commits list",
            );
            return new Map(commits.map((commit) => [commit.id, commit]));
        } catch {
            return new Map();
        }
    };

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
            // One jobs call fills in commit+author for the page; commits call follows only if something's still bare.
            const meta = await metaFromJobs(project);
            const bare = listed.filter((pipeline) => meta.get(pipeline.id)?.title === undefined);
            const commits = bare.length > 0 ? await commitsBySha(project) : new Map<string, GitlabCommit>();
            return listed.map((pipeline) => {
                const known = meta.get(pipeline.id);
                if (known !== undefined) {
                    return gitlabRun(project, pipeline, known);
                }
                const commit = commits.get(pipeline.sha);
                return gitlabRun(project, pipeline, {
                    ...(commit?.title !== undefined ? { title: commit.title } : {}),
                    ...(commit?.author_name !== undefined ? { authorName: commit.author_name } : {}),
                });
            });
        },
        failedJobs: async (project, runId) => (await failedJobsOf(project, runId)).map((job) => job.name),
        // `stage` is native here; the view groups by it directly, timestamps only order stages by actual start.
        allJobs: async (project, runId) => {
            const listed = await json<
                {
                    id: number;
                    name: string;
                    status: string;
                    stage: string;
                    duration: number | null;
                    started_at: string | null;
                    finished_at: string | null;
                    web_url?: string;
                }[]
            >(await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?per_page=100`), { headers: gitlabHeaders(project) }), "gitlab all jobs");
            return listed.map((job) => {
                const started = epoch(job.started_at);
                const finished = epoch(job.finished_at);
                const result: PipelineJob = { name: job.name, status: gitlabStatus(job.status), stage: job.stage };
                if (job.web_url !== undefined) {
                    result.webUrl = job.web_url;
                }
                if (started > 0) {
                    result.startedAt = started;
                }
                if (finished > 0) {
                    result.finishedAt = finished;
                }
                if (job.duration !== null) {
                    result.durationSeconds = Math.round(job.duration);
                }
                return result;
            });
        },
        failedJobLogs: async (project, runId, maxBytes) => {
            const failed = await failedJobsOf(project, runId);
            const parts: string[] = [];
            let budget = maxBytes;
            for (const job of failed) {
                if (budget <= 0) {
                    break;
                }
                const response = await fetchFn(gitlabApi(project, `/jobs/${job.id}/trace`), { headers: gitlabHeaders(project) });
                const text = response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`;
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
