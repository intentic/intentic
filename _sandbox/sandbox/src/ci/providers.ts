import { isPipelineInFlight, type PipelineJob, type PipelineRun, type PipelineStatus } from "@intentic/sandbox-contract";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import { plainText } from "../terminal/plain-text.js";
import type { CiProject } from "./projects.js";
import { localWorkflowCalls, resolveNeeds } from "./workflowGraph.js";

/* The two vendors' pipeline APIs behind one client shape, keyed off the account a project mapped to
 * (projects.ts). Everything the CI surface does, the view's run list, rerun/cancel, the fix context's log
 * tails, and the webhook reconciler's hook CRUD, goes through here, so the vendor branch exists exactly once.
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
    // Newest-first recent runs, normalized. `failedJobs` is NOT filled here, list calls are the hot path.
    readonly listRuns: (project: CiProject, limit: number) => Promise<PipelineRun[]>;
    // Names of the run's failed jobs, the one-extra-call enrichment for failed runs.
    readonly failedJobs: (project: CiProject, runId: number) => Promise<string[]>;
    // All jobs in a run with their individual statuses, the expanded-row enrichment for the view.
    readonly allJobs: (project: CiProject, runId: number) => Promise<PipelineJob[]>;
    // The failed jobs' log tails, concatenated and capped, the fix conversation's context. A runner prints for
    // a terminal, so each log is reduced to plain text (plain-text.ts) before it is capped: the cap then buys
    // failure rather than colour codes, and the prompt is readable to the human editing it.
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

// Whether a run or job is over, which is the only case in which the span between two of its timestamps is a
// DURATION. While it is still moving that span is elapsed-so-far, and while it is queued it is time spent
// waiting for a runner: neither is what a reader takes "3m 12s" beside a pipeline to mean.
const isSettled = (status: PipelineStatus): boolean => !isPipelineInFlight(status);

// ---- github: Actions workflow runs ----

/* Actions' pre-run vocabulary, the words for "accepted, nothing is executing it": `queued` is the everyday one,
 * `waiting` is a job held for a deployment approval, and `requested`/`pending` are the moments before a job is
 * handed to a runner. Anything else non-terminal is `in_progress` or a word Actions has not shipped yet, and
 * reads as running: overstating a novel status as moving is the safer of the two mistakes, since it is the
 * reading this had for every status before queued existed. */
const GITHUB_QUEUED = new Set(["queued", "waiting", "requested", "pending"]);

// A completed run's conclusion fans out into the three terminal buckets, with everything that means "did not
// pass", failure, timed_out, startup_failure, action_required, reading as failed.
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
    // Who set the run off. Present on both the runs list and the workflow_run webhook, so the view's avatar
    // costs no extra call on either path. Actions' own UI credits this same actor.
    readonly actor?: { readonly login?: string; readonly avatar_url?: string } | null;
    // push | pull_request | schedule | workflow_dispatch | …
    readonly event?: string;
}

// One workflow_run object → the normalized run, shared verbatim by the list call and the webhook receiver
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
    /* THE RUN'S OWN WORKFLOW FILE, at the commit it ran on, the only place the dependency graph exists (see
     * workflowGraph.ts). Two hops, because the jobs endpoint knows neither which file it came from nor which
     * revision of it: the run object carries `path` + `head_sha`, and contents serves that exact revision.
     * Pinning to the sha matters more than it looks, reading HEAD instead would draw last week's run with
     * this morning's graph, and be most wrong precisely when someone is looking at an old failure to see what
     * changed.
     *
     * Undefined, never a throw, for every way this legitimately comes up empty: a token without `contents`
     * (the CI scopes do not imply it), a private or since-deleted workflow, or a run started by a reusable
     * workflow in another repository, whose `path` is `owner/repo/file@ref` and resolves nowhere here. The
     * graph is an enrichment; failing to get it must never cost the caller the job list it came for.
     *
     * THE FILES IT CALLS COME TOO, when they live in this repository. A `uses: ./.github/workflows/release.yml`
     * job reports one job per job of the called file, and without that file they can only be siblings; with it
     * they are the chain they were written as. One extra request per called file, at the same sha, and a round
     * per level of nesting, three requests on the workspace's own CI. A file that fails to fetch is simply not
     * in the map, which is the same unfollowed call as one in another repository. */
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
        /* No `stage` is emitted: Actions has no stage concept. `needs` is, when the run's own workflow file can
         * be read, see workflowGraph.ts for why the graph has to come from there, and note that the file is
         * fetched ALONGSIDE the job list rather than after it, since only the name-matching needs both. When it
         * cannot be read the jobs go out exactly as they always did and the view layers them off timestamps. */
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
                /* A QUEUED JOB HAS NOT STARTED, whatever Actions says. Its `started_at` comes back set, to the
                 * moment the RUN was queued rather than to anything this job did, so a job that has been waiting
                 * an hour for an offline runner arrives looking like an hour of work in progress. Dropping it
                 * here is what lets the view lay those jobs out as the trailing queued wave they are, and what
                 * keeps a duration off a job that has done nothing. */
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
                // The logs endpoint 302-redirects to a short-lived blob url; fetch follows it. A job whose log
                // is already expired shouldn't sink the whole context, skip it and say so.
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

/* gitlab's single status string: the terminal states map straight across, and everything that has not been
 * picked up by a runner yet is queued. `manual` and `scheduled` belong there too, they are jobs waiting on a
 * person or a clock rather than on capacity, but "nothing is executing this" is the fact a reader needs and it
 * is the same fact. An unrecognized word reads as running, for the same reason it does on the github side. */
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

// A pipelines-list row names neither its commit nor its author, so listRuns joins both in. Everything here
// rides on responses the vendor already hands us whole, see gitlabMeta below for where it comes from.
export interface GitlabRunMeta {
    readonly title?: string;
    readonly authorName?: string;
    readonly authorAvatarUrl?: string;
    readonly trigger?: string;
}

// One pipelines-list row → the normalized run. The list carries no duration; a terminal pipeline's
// created→updated span stands in, which measured within 7% of the vendor's own figure across a live sample,
// the gap is queue time, so it isn't worth a per-run detail call. Webhook events carry the true one and
// overwrite this in the cache. `meta` is the listRuns enrichment; absent still yields a valid run.
export const gitlabRun = (project: Pick<CiProject, "repo" | "project">, pipeline: GitlabPipeline, meta: GitlabRunMeta = {}): PipelineRun => {
    const status = gitlabStatus(pipeline.status);
    const created = epoch(pipeline.created_at);
    const updated = epoch(pipeline.updated_at);
    // A named pipeline says more than a commit subject; fall back to the subject when it has no name.
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

// The Pipeline Hook payload's shape differs from the list row's (attributes nested, the true duration and
// finished_at present, no web_url on older instances), its own normalizer, sharing the status mapping.
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

// The project-wide jobs feed is the cheap way to learn what a page of pipelines was about: every job carries
// its pipeline's whole commit AND the user who triggered it. 100 jobs reached 28 distinct pipelines on a live
// repo, every one of the 15 the view asks for. A job-dense repo will reach fewer, which is what the commits
// fallback below is for.
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
    // Enrichment never fails a listing: every catch here is a deliberate swallow, not a rethrow, a token
    // scoped too narrowly to read jobs or commits still deserves its run list.
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
                // The triggering user, not the commit author, it's who both vendors' own UIs credit, and the
                // one that arrives with a real avatar rather than an email to guess a gravatar from.
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

    // Fallback for pipelines the jobs feed didn't reach. Cheaper data, a subject and an author name, no
    // avatar, but one call, and only issued when something actually came back bare. `all` sweeps every ref,
    // so a pipeline on a side branch resolves too.
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
            // A pipeline row names neither its commit nor its author, so the view would read "ref @ sha" for
            // every run. One jobs call fills that in for the whole page; the commits call only follows if that
            // left something bare. Both sit on the cache-miss backfill path rather than the poll.
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
        // `stage` is native here, so the view groups by it directly; the timestamps still ride along to order
        // the stages by when they actually started.
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
