import { isPipelineInFlight, type PipelineJob, type PipelineRun, type PipelineStatus } from "@intentic/sandbox-contract/schemas/ci";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import { BoundedMap } from "@intentic/base/held";
import { plainText } from "@intentic/base/plain-text";
import { cooled } from "./forge/forge-cooldown.js";
import { throwOn } from "./forge-refusals.js";
import { cancelledFailures } from "./forge/github-cancels.js";
import { jobLists } from "./forge/job-lists.js";
import type { CiProject } from "./projects.js";
import { z } from "zod";
import { remoteWorkflow, resolveRun, type RunJob, workflowCalls } from "./workflowGraph.js";

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
    // GitLab's word for why the job failed (`script_failure`, `runner_system_failure`, …), where it gives one; on GitHub,
    // why a job it reports as cancelled is a failure after all (CANCEL_CAUSES): `timed_out` or `runner_unavailable`.
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
    // Names of the run's jobs that passed: what a run that did not pass as a whole still says of the jobs failing on
    // main (main-fixer.ts, recovered).
    readonly passedJobs: (project: CiProject, runId: number) => Promise<string[]>;
    // One run by its id, however old: the list calls reach only the newest.
    readonly run: (project: CiProject, runId: number) => Promise<PipelineRun>;
    // A fresh run of the run's workflow on its branch as it is now, rather than the old commit again. GitHub refuses a
    // workflow that takes no manual start (`workflow_dispatch`).
    readonly dispatch: (project: CiProject, runId: number) => Promise<void>;
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

const json = async <T>(response: Response, what: string): Promise<T> => (await throwOn(response, what)).json() as Promise<T>;

const epoch = (iso: string | undefined | null): number => {
    const parsed = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
    return Number.isNaN(parsed) ? 0 : parsed;
};

// Whether a run/job is over; only then is the span between its timestamps a duration, not elapsed-so-far or queue wait.
const isSettled = (status: PipelineStatus): boolean => !isPipelineInFlight(status);

// One run, as every per-run reading here is filed: the account's API, the project, the run.
const runKey = (project: CiProject, runId: number): string => `${project.account.apiBase}\n${project.project}\n${runId}`;

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
const githubGet = (fetchFn: FetchFn, project: CiProject, path: string): Promise<Response> =>
    fetchFn(githubApi(project, path), { headers: githubHeaders(project.account.token) });

// What a POST to a forge's API sends, as JSON.
type ForgeJson = string | number | boolean | null | readonly ForgeJson[] | { readonly [key: string]: ForgeJson };
type ForgeBody = { readonly [key: string]: ForgeJson };

// A POST to a forge's API, with a JSON body when it takes one; a refusal throws with what the forge said.
const postTo = async (fetchFn: FetchFn, url: string, headers: Record<string, string>, what: string, body?: ForgeBody): Promise<void> => {
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
        init.headers = { ...headers, "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
    }
    await throwOn(await fetchFn(url, init), what);
};

// The run names its workflow by id and its branch; a dispatch starts that workflow on the branch's head.
const githubDispatch = async (fetchFn: FetchFn, project: CiProject, runId: number): Promise<void> => {
    const run = await json<{ readonly workflow_id: number; readonly head_branch: string | null }>(
        await githubGet(fetchFn, project, `/actions/runs/${runId}`),
        "github run",
    );
    const dispatches = githubApi(project, `/actions/workflows/${run.workflow_id}/dispatches`);
    await postTo(fetchFn, dispatches, githubHeaders(project.account.token), "github workflow dispatch", { ref: run.head_branch ?? "" });
};

interface WorkflowSource {
    readonly root: string;
    // Reusable workflows the root calls, by repository path; the graph needs their jobs too.
    readonly called: Map<string, string>;
}

// A run's workflow files are read at its own head sha, so they never change once resolved: read once per run however
// often its jobs are re-read. Only successes are kept, and the window is a board's worth of runs, not a history.
const WORKFLOW_SOURCES_KEPT = 100;
const workflowSources = new BoundedMap<string, WorkflowSource>(WORKFLOW_SOURCES_KEPT);

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

// A job of a run as main's fix agent hears of it: failed, or cancelled in a way that is a failure after all (`cause`,
// forge/github-cancels.ts); none for any other.
const githubFailedStep = (job: GithubJob, cause: string | undefined): FailedStep[] => {
    if (cause === undefined && (job.conclusion === null || githubStatus("completed", job.conclusion) !== "failed")) {
        return [];
    }
    const steps = (job.steps ?? []).filter((candidate) => candidate.conclusion === "failure").map((candidate) => candidate.name);
    const step = steps[0];
    const named: FailedStep = step === undefined ? { job: job.name, id: job.id } : { job: job.name, id: job.id, step, steps };
    return [cause === undefined ? named : { ...named, reason: cause }];
};

// Settled once every job has completed; an empty list is a run whose jobs have not been made yet.
const githubJobLists = jobLists<GithubJob>((jobs) => jobs.length > 0 && jobs.every((job) => job.status === "completed"));

// What a sandbox's hook on a GitHub repository delivers: each finished run, and each finished job, so a failure is heard
// the moment its job fails rather than when the whole run does.
const GITHUB_HOOK_EVENTS = ["workflow_run", "workflow_job"];

// One job of the drawn graph: a reported job with its declared wiring, or a job only the workflow declares, which links
// to the job its call was reported as when there is one.
const graphJob = (job: RunJob, reported: readonly PipelineJob[]): PipelineJob => {
    const own = job.reported === undefined ? undefined : reported[job.reported];
    const standIn = job.standIn === undefined ? undefined : reported[job.standIn];
    const base: PipelineJob = own ?? { name: job.name, status: job.status, ...(standIn?.webUrl === undefined ? {} : { webUrl: standIn.webUrl }) };
    return {
        ...base,
        ...(job.needs === undefined ? {} : { needs: [...job.needs] }),
        ...(job.declaredId === undefined ? {} : { declaredId: job.declaredId }),
        ...(job.matrix === undefined ? {} : { matrix: job.matrix }),
    };
};

// Called workflow files read for one run's graph, at most.
const CALLED_FILES_READ = 40;

const githubClient = (fetchFn: FetchFn): CiClient => {
    // Resolves the run's workflow file at its exact sha, not HEAD, so an old run isn't drawn with the wrong graph; a
    // file of another repository is read from it, at the ref its call pins. Undefined, never a throw, for any
    // legitimate empty case; the graph is enrichment only.
    const fileAt = async (project: CiProject, path: string, ref: string, repo = project.project): Promise<string | undefined> => {
        // `.raw` hands back the file itself; the default json media type would wrap it in base64.
        const file = await fetchFn(`${project.account.apiBase}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
            headers: { ...githubHeaders(project.account.token), Accept: "application/vnd.github.raw" },
        });
        return file.ok ? await file.text() : undefined;
    };
    // A called file by the key workflowCalls named it with: a path in the run's repository, or another's call.
    const calledFile = (project: CiProject, key: string, ref: string): Promise<string | undefined> => {
        const remote = remoteWorkflow(key);
        return remote === undefined ? fileAt(project, key, ref) : fileAt(project, remote.path, remote.ref, remote.repo);
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
        let frontier = workflowCalls(root);
        // However a ring of repositories is wired, a run's graph is not worth more reads than this.
        while (frontier.length > 0 && asked.size <= CALLED_FILES_READ) {
            const wanted = [...new Set(frontier)].filter((key) => !asked.has(key)).slice(0, CALLED_FILES_READ + 1 - asked.size);
            for (const key of wanted) {
                asked.add(key);
            }
            const fetched = await Promise.all(wanted.map(async (key) => [key, await calledFile(project, key, ref)] as const));
            frontier = [];
            for (const [key, source] of fetched) {
                if (source !== undefined) {
                    called.set(key, source);
                    frontier.push(...workflowCalls(source, key));
                }
            }
        }
        const source: WorkflowSource = { root, called };
        workflowSources.set(cacheKey, source);
        return source;
    };
    const post = (project: CiProject, path: string, what: string, body?: ForgeBody): Promise<void> =>
        postTo(fetchFn, githubApi(project, path), githubHeaders(project.account.token), what, body);
    const listJobs = (project: CiProject, runId: number, what: string) => async (): Promise<GithubJob[]> =>
        (
            await json<{ jobs: GithubJob[] }>(
                await fetchFn(githubApi(project, `/actions/runs/${runId}/jobs?per_page=100`), { headers: githubHeaders(project.account.token) }),
                what,
            )
        ).jobs;
    const jobListOf = (project: CiProject, runId: number): Promise<GithubJob[]> =>
        githubJobLists.kept(fetchFn, runKey(project, runId), listJobs(project, runId, "github jobs list"));
    // A fix's reading, which takes the list the board's row just read (githubJobLists) rather than waiting on it again:
    // every job that failed, and every cancelled one whose cancel says it failed after all, in the run's order.
    const jobsOf = async (project: CiProject, runId: number): Promise<FailedStep[]> => {
        const listed = await jobListOf(project, runId);
        const cancels = await cancelledFailures(listed, runKey(project, 0), (jobId) =>
            fetchFn(githubApi(project, `/check-runs/${jobId}/annotations`), { headers: githubHeaders(project.account.token) }),
        );
        return listed.flatMap((job) => githubFailedStep(job, cancels.get(job)));
    };
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
        failedJobs: async (project, runId) => (await jobsOf(project, runId)).map(({ job }) => job),
        failedSteps: jobsOf,
        passedJobs: async (project, runId) => (await jobListOf(project, runId)).filter((job) => job.conclusion === "success").map((job) => job.name),
        run: async (project, runId) => githubRun(project, await json<GithubRun>(await githubGet(fetchFn, project, `/actions/runs/${runId}`), "github run")),
        dispatch: (project, runId) => githubDispatch(fetchFn, project, runId),
        // No `stage`: Actions has no such concept. `needs` is filled only when the run's workflow file can be read,
        // fetched alongside the job list, not after; unreadable, jobs go out as listed. Readable, the list is the run's
        // graph as GitHub draws it: every declared job, the ones not reported yet (or never) included, in its order.
        allJobs: async (project, runId) => {
            const [listed, workflow] = await Promise.all([
                githubJobLists.read(fetchFn, runKey(project, runId), listJobs(project, runId, "github all jobs")),
                workflowSource(project, runId),
            ]);
            const reported = listed.map((job) => {
                const status = githubStatus(job.status, job.conclusion);
                const started = epoch(job.started_at);
                const completed = epoch(job.completed_at);
                const result: PipelineJob = { name: job.name, status };
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
            const graph = workflow === undefined ? undefined : resolveRun(workflow.root, reported, workflow.called);
            return graph === undefined ? reported : graph.map((job) => graphJob(job, reported));
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
    readonly project: {
        readonly id?: number;
        readonly path_with_namespace: string;
        readonly web_url: string;
        readonly default_branch?: string | null;
    };
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

const gitlabPipelineOf = async (fetchFn: FetchFn, project: CiProject, runId: number): Promise<GitlabPipeline> =>
    json<GitlabPipeline>(await fetchFn(gitlabApi(project, `/pipelines/${runId}`), { headers: gitlabHeaders(project) }), "gitlab pipeline");

const gitlabPassedJobs = async (fetchFn: FetchFn, project: CiProject, runId: number): Promise<string[]> =>
    (
        await json<{ readonly name: string }[]>(
            await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?scope[]=success&per_page=100`), { headers: gitlabHeaders(project) }),
            "gitlab passed jobs",
        )
    ).map((job) => job.name);

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

    const post = (project: CiProject, path: string, what: string, body?: ForgeBody): Promise<void> =>
        postTo(fetchFn, gitlabApi(project, path), gitlabHeaders(project), what, body);
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
        passedJobs: (project, runId) => gitlabPassedJobs(fetchFn, project, runId),
        run: async (project, runId) => gitlabRun(project, await gitlabPipelineOf(fetchFn, project, runId)),
        // A commit's one pipeline is the project's: a new one on the pipeline's ref is the same workflow on its head.
        dispatch: async (project, runId) => post(project, "/pipeline", "gitlab pipeline create", { ref: (await gitlabPipelineOf(fetchFn, project, runId)).ref }),
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

export const ciClientFor = (host: "github" | "gitlab", fetchFn: FetchFn = fetch): CiClient =>
    cooled(host === "github" ? githubClient(fetchFn) : gitlabClient(fetchFn), fetchFn);
