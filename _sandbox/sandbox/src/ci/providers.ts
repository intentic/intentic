import { isPipelineInFlight, type PipelineJob, type PipelineRun, type PipelineStatus } from "@intentic/sandbox-contract";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import { plainText } from "@intentic/base/plain-text";
import type { CiProject } from "./projects.js";
import { z } from "zod";
import { localWorkflowCalls, resolveNeeds } from "./workflowGraph.js";

// Both vendors' pipeline APIs behind one client shape (CiClient), keyed off the account a project mapped to; the vendor
// branch exists exactly once. `fetch` is injectable for tests; failures throw with the vendor's status and body tail, and a
// spent rate limit throws CiRateLimited, after which the account is left alone until it lifts.

// The call shape only, not `typeof fetch`: a test's stand-in answers requests, it does not carry fetch's own statics.
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Delivery target: the daemon's public receiver plus the signing secret (github signs with it, gitlab echoes it as
// X-Gitlab-Token).
export interface HookSpec {
    readonly url: string;
    readonly secret: string;
}

export interface FailedStep {
    readonly job: string;
    // The job's own id, which its log is read by (jobLog).
    readonly id: number;
    // The first step that failed it. Absent where the forge has no steps (GitLab), which reads as the code's own failure.
    readonly step?: string;
    // Every step that failed it, in order: a job whose steps each run whatever the one before concluded can fail
    // several. Absent where the forge has no steps.
    readonly steps?: readonly string[];
    // GitLab's word for why the job failed (`script_failure`, `runner_system_failure`, …), where it gives one.
    readonly reason?: string;
}

export interface CiClient {
    // Newest-first normalized runs; failedJobs is not filled here, list calls are the hot path.
    readonly listRuns: (project: CiProject, limit: number) => Promise<PipelineRun[]>;
    // Names of the run's failed jobs, the one-extra-call enrichment for failed runs.
    readonly failedJobs: (project: CiProject, runId: number) => Promise<string[]>;
    // Each failed job with the step that failed it, where the forge names steps; a runner-owned step (Set up job) says
    // the fleet died, not the code. A job allowed to fail is none of them. Read while the run is still going too: a job
    // that already failed is listed.
    readonly failedSteps: (project: CiProject, runId: number) => Promise<FailedStep[]>;
    // All jobs in a run with their individual statuses, the expanded-row enrichment for the view.
    readonly allJobs: (project: CiProject, runId: number) => Promise<PipelineJob[]>;
    // One job's log, reduced to plain text (plain-text.ts) and cut to its last `maxBytes` (Infinity reads it whole); an
    // expired or unreadable log says so in its place.
    readonly jobLog: (project: CiProject, jobId: number, maxBytes: number) => Promise<string>;
    readonly rerun: (project: CiProject, runId: number) => Promise<void>;
    readonly cancel: (project: CiProject, runId: number) => Promise<void>;
    // Idempotent: a hook already delivering to spec.url is left alone, otherwise one is created.
    readonly ensureHook: (project: CiProject, spec: HookSpec) => Promise<void>;
    // Best-effort inverse; a hook is identified by its delivery url alone.
    readonly removeHook: (project: CiProject, url: string) => Promise<void>;
    // The forge's own word on the project, through any redirect a rename left: its stable id, where it lives now, and
    // its default branch.
    readonly repository: (project: CiProject) => Promise<ForgeRepository>;
    readonly projectUrl: (project: CiProject) => string;
}

export interface ForgeRepository {
    readonly id: number;
    readonly path: string;
    readonly defaultBranch?: string | undefined;
}

/** The forge refused because the token's API rate limit is spent, not because of anything about the request: nothing
 *  on this account is asked again until `until` (epoch ms). Every caller shares one token with the agents' own `gh`. */
export class CiRateLimited extends Error {
    constructor(
        what: string,
        readonly until: number,
    ) {
        super(`${what} is rate-limited until ${new Date(until).toISOString()}`);
        this.name = "CiRateLimited";
    }
}

// How long to hold off when a forge says its limit is spent but not until when.
const RATE_LIMIT_FALLBACK_MS = 60_000;

// When a refusal is a spent rate limit, the moment it lifts. GitHub says it with a 403 or a 429: X-RateLimit-Remaining 0
// for the primary limit, Retry-After or the body's own words for the secondary one; any other 403 is about the token or
// the repository. GitLab says it with a 429 and RateLimit-Reset.
const rateLimitLifts = (response: Response, body: string, now: number): number | undefined => {
    if (response.status !== 403 && response.status !== 429) {
        return undefined;
    }
    const headers = response.headers;
    const retryAfter = headers.get("retry-after");
    if (
        response.status === 403 &&
        (headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining")) !== "0" &&
        retryAfter === null &&
        !/rate limit|abuse detection/i.test(body)
    ) {
        return undefined;
    }
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return now + seconds * 1000;
    }
    const reset = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset") ?? Number.NaN);
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + RATE_LIMIT_FALLBACK_MS;
};

const BODY_TAIL = 300;

const throwOn = async (response: Response, what: string): Promise<Response> => {
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const lifts = rateLimitLifts(response, body, Date.now());
        if (lifts !== undefined) {
            throw new CiRateLimited(what, lifts);
        }
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

// One run, as every per-run reading here is filed: the account's API, the project, the run.
const runKey = (project: CiProject, runId: number): string => `${project.account.apiBase}\n${project.project}\n${runId}`;

// ---- job lists, shared by their readers ----

// A Fix press waits on its run's job list before any agent exists (ci-fix.ts ciFailureEvidence), and reads it three ways
// at once; the board's row read the very same list moments before the press, to draw its stage circles. So readers share
// one request while it is out, and a list is kept past it only once `settled` says it cannot move short of a re-run:
// briefly, which bounds a re-run started outside this sandbox, while one started here forgets it at once. Kept per
// transport, so one test's stand-in never answers another's read.
const JOB_LISTS_FRESH_MS = 120_000;
const JOB_LISTS_KEPT = 100;

interface JobLists<T> {
    // Always asks the vendor, and keeps what it answers: the board's own reads, so its graph is never a kept copy.
    readonly read: (fetchFn: FetchFn, key: string, list: () => Promise<T[]>) => Promise<T[]>;
    // The list as last read, while it is fresh; read otherwise.
    readonly kept: (fetchFn: FetchFn, key: string, list: () => Promise<T[]>) => Promise<T[]>;
    readonly forget: (fetchFn: FetchFn, key: string) => void;
}

const jobLists = <T>(settled: (jobs: readonly T[]) => boolean): JobLists<T> => {
    const byTransport = new WeakMap<FetchFn, Map<string, { readonly at: number; readonly jobs: Promise<T[]> }>>();
    const listsOf = (fetchFn: FetchFn): Map<string, { readonly at: number; readonly jobs: Promise<T[]> }> => {
        const known = byTransport.get(fetchFn);
        if (known !== undefined) {
            return known;
        }
        const fresh = new Map<string, { readonly at: number; readonly jobs: Promise<T[]> }>();
        byTransport.set(fetchFn, fresh);
        return fresh;
    };
    const read: JobLists<T>["read"] = (fetchFn, key, list) => {
        const lists = listsOf(fetchFn);
        const jobs = list();
        // Re-inserted, so the oldest entry is always the first one the map yields.
        lists.delete(key);
        lists.set(key, { at: Date.now(), jobs });
        const oldest = lists.size > JOB_LISTS_KEPT ? lists.keys().next().value : undefined;
        if (oldest !== undefined) {
            lists.delete(oldest);
        }
        // Only this read's own entry: a later read of the same run may already stand in its place.
        const drop = (): void => {
            if (lists.get(key)?.jobs === jobs) {
                lists.delete(key);
            }
        };
        jobs.then((answered) => {
            if (!settled(answered)) {
                drop();
            }
        }, drop);
        return jobs;
    };
    return {
        read,
        kept: (fetchFn, key, list) => {
            const held = listsOf(fetchFn).get(key);
            return held !== undefined && Date.now() - held.at < JOB_LISTS_FRESH_MS ? held.jobs : read(fetchFn, key, list);
        },
        forget: (fetchFn, key) => {
            listsOf(fetchFn).delete(key);
        },
    };
};

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
    // The workflow's name, which its jobs' webhooks name too (`workflow_name`).
    readonly name?: string;
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
        ...(run.name !== undefined && run.name !== "" ? { workflow: run.name } : {}),
        branch: run.head_branch ?? "",
        sha: run.head_sha,
        status,
        url: run.html_url,
        createdAt: epoch(run.created_at),
        ...(isSettled(status) && ended > started ? { durationSeconds: Math.round((ended - started) / 1000) } : {}),
    };
};

const githubApi = (project: CiProject, path: string): string => `${project.account.apiBase}/repos/${project.project}${path}`;

interface WorkflowSource {
    readonly root: string;
    // Reusable workflows the root calls, by repository path; the graph needs their jobs too.
    readonly called: Map<string, string>;
}

// A run's workflow files are read at its own head sha, so they never change once resolved: read once per run however
// often its jobs are re-read. Only successes are kept, and the window is a board's worth of runs, not a history.
const WORKFLOW_SOURCES_KEPT = 100;
const workflowSources = new Map<string, WorkflowSource>();

const rememberWorkflowSource = (key: string, source: WorkflowSource): void => {
    workflowSources.set(key, source);
    const oldest = workflowSources.size > WORKFLOW_SOURCES_KEPT ? workflowSources.keys().next().value : undefined;
    if (oldest !== undefined) {
        workflowSources.delete(oldest);
    }
};

// One job of a run's list as Actions serves it, read whole by both the row's graph (allJobs) and a fix (jobsOf).
interface GithubJob {
    readonly id: number;
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly html_url: string | null;
    readonly steps?: readonly { readonly name: string; readonly conclusion: string | null }[];
}

// Settled once every job has completed; an empty list is a run whose jobs have not been made yet.
const githubJobLists = jobLists<GithubJob>((jobs) => jobs.length > 0 && jobs.every((job) => job.status === "completed"));

// What a sandbox's hook on a GitHub repository delivers: each finished run, and each finished job, so a failure is heard
// the moment its job fails rather than when the whole run does.
const GITHUB_HOOK_EVENTS = ["workflow_run", "workflow_job"];

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
    const workflowSource = async (project: CiProject, runId: number): Promise<WorkflowSource | undefined> => {
        const cacheKey = runKey(project, runId);
        const remembered = workflowSources.get(cacheKey);
        if (remembered !== undefined) {
            return remembered;
        }
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
        const source: WorkflowSource = { root, called };
        rememberWorkflowSource(cacheKey, source);
        return source;
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
    const listJobs = (project: CiProject, runId: number, what: string) => async (): Promise<GithubJob[]> =>
        (
            await json<{ jobs: GithubJob[] }>(
                await fetchFn(githubApi(project, `/actions/runs/${runId}/jobs?per_page=100`), { headers: githubHeaders(project.account.token) }),
                what,
            )
        ).jobs;
    // A fix's reading, which takes the list the board's row just read (githubJobLists) rather than waiting on it again.
    const jobsOf = async (project: CiProject, runId: number): Promise<GithubJob[]> =>
        (await githubJobLists.kept(fetchFn, runKey(project, runId), listJobs(project, runId, "github jobs list"))).filter(
            (job) => job.conclusion !== null && githubStatus("completed", job.conclusion) === "failed",
        );
    // Redirects to a short-lived blob url; fetch follows it. An expired log is reported inline, not fatal.
    const logOf = async (project: CiProject, jobId: number, maxBytes: number): Promise<string> => {
        const response = await fetchFn(githubApi(project, `/actions/jobs/${jobId}/logs`), { headers: githubHeaders(project.account.token) });
        return (response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`).slice(-maxBytes);
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
        failedSteps: async (project, runId) =>
            (await jobsOf(project, runId)).map((job) => {
                const steps = (job.steps ?? []).filter((candidate) => candidate.conclusion === "failure").map((candidate) => candidate.name);
                const step = steps[0];
                return step === undefined ? { job: job.name, id: job.id } : { job: job.name, id: job.id, step, steps };
            }),
        // No `stage`: Actions has no such concept. `needs` is filled only when the run's workflow file can be read,
        // fetched alongside the job list, not after; unreadable, jobs go out as before.
        allJobs: async (project, runId) => {
            const [listed, workflow] = await Promise.all([
                githubJobLists.read(fetchFn, runKey(project, runId), listJobs(project, runId, "github all jobs")),
                workflowSource(project, runId),
            ]);
            const needs =
                workflow === undefined
                    ? undefined
                    : resolveNeeds(
                          workflow.root,
                          listed.map((job) => job.name),
                          workflow.called,
                      );
            return listed.map((job) => {
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
        jobLog: (project, jobId, maxBytes) => logOf(project, jobId, maxBytes),
        // A re-run makes the run's jobs anew, so the list kept for it no longer describes it.
        rerun: (project, runId) => {
            githubJobLists.forget(fetchFn, runKey(project, runId));
            return post(project, `/actions/runs/${runId}/rerun`, "github rerun");
        },
        cancel: (project, runId) => post(project, `/actions/runs/${runId}/cancel`, "github cancel"),
        ensureHook: async (project, spec) => {
            const hooks = await json<{ id: number; events?: string[]; config?: { url?: string } }[]>(
                await fetchFn(githubApi(project, "/hooks"), { headers: githubHeaders(project.account.token) }),
                "github hooks list",
            );
            const mine = hooks.find((hook) => hook.config?.url === spec.url);
            if (mine === undefined) {
                await post(project, "/hooks", "github hook create", {
                    name: "web",
                    active: true,
                    events: GITHUB_HOOK_EVENTS,
                    config: { url: spec.url, content_type: "json", secret: spec.secret },
                });
                return;
            }
            // A hook registered before jobs were heard one by one delivers finished runs only: it learns the rest.
            const missing = GITHUB_HOOK_EVENTS.filter((event) => !(mine.events ?? []).includes(event));
            if (missing.length > 0) {
                await throwOn(
                    await fetchFn(githubApi(project, `/hooks/${mine.id}`), {
                        method: "PATCH",
                        headers: { ...githubHeaders(project.account.token), "Content-Type": "application/json" },
                        body: JSON.stringify({ add_events: missing }),
                    }),
                    "github hook update",
                );
            }
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
        repository: async (project) => {
            const repo = GithubRepositorySchema.parse(
                await json<unknown>(await fetchFn(githubApi(project, ""), { headers: githubHeaders(project.account.token) }), "github repository"),
            );
            return { id: repo.id, path: repo.full_name, defaultBranch: repo.default_branch ?? undefined };
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
    // `id` and `default_branch` are the forge's word on the project (main-line.ts), not on the run.
    readonly project: { readonly id?: number; readonly path_with_namespace: string; readonly web_url: string; readonly default_branch?: string | null };
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

interface GitlabFailedJob {
    readonly id: number;
    readonly name: string;
    readonly allow_failure?: boolean;
    readonly failure_reason?: string;
}

// Never settled: the failed-only list a fix reads is shared while out (jobLists) and not kept past it.
const gitlabFailedLists = jobLists<GitlabFailedJob>(() => false);

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
    // A job allowed to fail fails nothing, so it is none of the pipeline's failures. Shared by a fix's three readings of
    // it (gitlabFailedLists), never kept: a failed-only list cannot say whether the pipeline is still going.
    const failedJobsOf = async (project: CiProject, runId: number): Promise<GitlabFailedJob[]> =>
        (
            await gitlabFailedLists.kept(fetchFn, runKey(project, runId), async () =>
                json<GitlabFailedJob[]>(
                    await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?scope[]=failed&per_page=100`), { headers: gitlabHeaders(project) }),
                    "gitlab jobs list",
                ),
            )
        ).filter((job) => job.allow_failure !== true);
    const traceOf = async (project: CiProject, jobId: number, maxBytes: number): Promise<string> => {
        const response = await fetchFn(gitlabApi(project, `/jobs/${jobId}/trace`), { headers: gitlabHeaders(project) });
        return (response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`).slice(-maxBytes);
    };
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
        failedSteps: async (project, runId) =>
            (await failedJobsOf(project, runId)).map((job) =>
                job.failure_reason === undefined ? { job: job.name, id: job.id } : { job: job.name, id: job.id, reason: job.failure_reason },
            ),
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
        jobLog: (project, jobId, maxBytes) => traceOf(project, jobId, maxBytes),
        rerun: (project, runId) => post(project, `/pipelines/${runId}/retry`, "gitlab retry"),
        cancel: (project, runId) => post(project, `/pipelines/${runId}/cancel`, "gitlab cancel"),
        ensureHook: async (project, spec) => {
            const hooks = await json<{ id: number; url: string; job_events?: boolean }[]>(
                await fetchFn(gitlabApi(project, "/hooks"), { headers: gitlabHeaders(project) }),
                "gitlab hooks list",
            );
            const mine = hooks.find((hook) => hook.url === spec.url);
            // Pipelines and jobs both: a failed job is heard the moment it fails, not when its pipeline does.
            const settings = {
                url: spec.url,
                token: spec.secret,
                pipeline_events: true,
                job_events: true,
                push_events: false,
                enable_ssl_verification: true,
            };
            if (mine === undefined) {
                await post(project, "/hooks", "gitlab hook create", settings);
                return;
            }
            // A hook registered before jobs were heard one by one learns them; the edit names the url and token again,
            // which GitLab's edit takes whole.
            if (mine.job_events !== true) {
                await throwOn(
                    await fetchFn(gitlabApi(project, `/hooks/${mine.id}`), {
                        method: "PUT",
                        headers: { ...gitlabHeaders(project), "Content-Type": "application/json" },
                        body: JSON.stringify(settings),
                    }),
                    "gitlab hook update",
                );
            }
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
        repository: async (project) => {
            const repo = GitlabProjectSchema.parse(
                await json<unknown>(await fetchFn(gitlabApi(project, ""), { headers: gitlabHeaders(project) }), "gitlab project"),
            );
            return { id: repo.id, path: repo.path_with_namespace, defaultBranch: repo.default_branch ?? undefined };
        },
        projectUrl: (project) => `${project.account.apiBase.replace(/\/api\/v4$/, "")}/${project.project}`,
    };
};

// The repository reads, narrowed to what they promise: an answer without an id or a path is no answer. An empty
// repository has no default branch yet.
const GithubRepositorySchema = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string().nullish() });
const GitlabProjectSchema = z.object({ id: z.number(), path_with_namespace: z.string(), default_branch: z.string().nullish() });

// ---- the rate limit, shared by every caller ----

// When each account's limit lifts, kept per transport like the job lists, so one test's stand-in never cools another's.
// An account is its API and its token: the limit is the token's, whichever repository asked.
const cooldowns = new WeakMap<FetchFn, Map<string, number>>();

// The client with the cooldown in front: while an account's limit is spent, every call on it fails at once with the same
// typed refusal instead of spending a request the forge will refuse, so the poller, the hook reconcile and the board's
// backfill all wait it out without each knowing about it.
const cooled = (client: CiClient, fetchFn: FetchFn): CiClient => {
    const held = cooldowns.get(fetchFn) ?? new Map<string, number>();
    cooldowns.set(fetchFn, held);
    const guard =
        <A extends unknown[], R>(call: (project: CiProject, ...rest: A) => Promise<R>) =>
        async (project: CiProject, ...rest: A): Promise<R> => {
            const account = `${project.account.apiBase}\n${project.account.token}`;
            const until = held.get(account);
            if (until !== undefined && Date.now() < until) {
                throw new CiRateLimited(`${project.account.host}'s API`, until);
            }
            held.delete(account);
            try {
                return await call(project, ...rest);
            } catch (error) {
                if (error instanceof CiRateLimited) {
                    held.set(account, Math.max(held.get(account) ?? 0, error.until));
                }
                throw error;
            }
        };
    return {
        listRuns: guard(client.listRuns),
        failedJobs: guard(client.failedJobs),
        failedSteps: guard(client.failedSteps),
        allJobs: guard(client.allJobs),
        jobLog: guard(client.jobLog),
        rerun: guard(client.rerun),
        cancel: guard(client.cancel),
        ensureHook: guard(client.ensureHook),
        removeHook: guard(client.removeHook),
        repository: guard(client.repository),
        projectUrl: client.projectUrl,
    };
};

export const ciClientFor = (host: "github" | "gitlab", fetchFn: FetchFn = fetch): CiClient =>
    cooled(host === "github" ? githubClient(fetchFn) : gitlabClient(fetchFn), fetchFn);
