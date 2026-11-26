import { errorMessage } from "@intentic/base/errors";
import { BoundedMap } from "@intentic/base/held";
import { parseJsonWith } from "@intentic/base/json";
import { plainText } from "@intentic/base/plain-text";
import type { CiDeploymentAnswer, CiDeploymentReport, PipelineJob } from "@intentic/sandbox-contract/schemas/ci";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { GitHost } from "../capabilities/cli/git-access.js";
import type { ForgeClient, FailedStep, LoginLookupWarn, WorkflowSource } from "./client.js";
import { annotationsOf, githubFailedStep, jobAnnotations } from "./github-cancels.js";
import { type FetchFn, type ForgeBody, githubHeaders, json, posted, postTo, readJson } from "./http.js";
import { jobLists, runKey } from "./job-lists.js";
import { type ForgeProject, projectPage, WorkspaceRemoteError } from "./projects.js";
import { CiRateLimited, CiRefused, throwOn } from "./refusals.js";
import { epoch, type GithubRun, githubRun, githubStatus, isSettled } from "./runs.js";
import { remoteWorkflow, workflowCalls } from "./workflow-calls.js";

// The repository reads, narrowed to what they promise: an answer without an id or a path is no answer. An empty
// repository has no default branch yet.
const GithubRepositorySchema = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string().nullish() });

const GithubUserSchema = z.object({ login: z.string() });

// The login the token authenticates as, to tell the owner's own account from an organization. A lookup that fails (a
// token that cannot read its user, a network error, an answer that is not JSON) is logged with its reason and read as
// no login: the owner is then taken for an organization, whose endpoint answers for itself, and publishing goes on
// rather than stopping at a question it did not need answered.
export const githubLogin = async (host: Pick<GitHost, "apiBase" | "token">, warn: LoginLookupWarn, fetcher: FetchFn = fetch): Promise<string | undefined> => {
    const unread = "publish: github would not say which account this token is, so the owner is taken for an organization";
    try {
        const user = await fetcher(`${host.apiBase}/user`, { headers: githubHeaders(host.token) });
        if (!user.ok) {
            warn({ status: user.status }, unread);
            return undefined;
        }
        return GithubUserSchema.safeParse(await readJson(user)).data?.login;
    } catch (error) {
        warn({ err: errorMessage(error) }, unread);
        return undefined;
    }
};

const createRepository = async (host: GitHost, name: string, owner: string | undefined, warn: LoginLookupWarn, fetcher: FetchFn): Promise<string> => {
    // github: an owner other than the authenticated user is an organization, with its own endpoint. No owner named is
    // the token's own account, with nothing to look up.
    const login = owner === undefined ? undefined : await githubLogin(host, warn, fetcher);
    const path = owner === undefined || owner === login ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`;
    const response = await fetcher(`${host.apiBase}${path}`, posted(githubHeaders(host.token), { name, private: true, auto_init: false }));
    if (!response.ok) {
        throw new WorkspaceRemoteError(
            `${host.host} refused to create "${name}": ${response.status} ${await response.text().catch(() => "")}`.trim(),
        );
    }
    const body = (await readJson(response).catch(() => ({}))) as { clone_url?: string };
    if (typeof body.clone_url !== "string" || body.clone_url === "") {
        throw new WorkspaceRemoteError(`${host.host} created the repository but returned no clone URL`);
    }
    return body.clone_url;
};

// What GitHub answers a deployment created, narrowed to the id its statuses go to.
const DeploymentSchema = z.object({ id: z.number() });

const reportDeployment = async (fetchFn: FetchFn, project: ForgeProject, report: CiDeploymentReport): Promise<CiDeploymentAnswer> => {
    const base = githubApi(project, "");
    const headers = githubHeaders(project.account.token);
    let deployment = report.deploymentId;
    if (deployment === undefined) {
        const created = await throwOn(
            await fetchFn(
                `${base}/deployments`,
                posted(
                    headers,
                    {
                        ref: report.sha,
                        environment: report.environment,
                        description: report.description,
                        auto_merge: false,
                        required_contexts: [],
                        transient_environment: false,
                        production_environment: report.production,
                    },
                ),
            ),
            `GitHub refused creating a deployment of ${report.environment}`,
        );
        deployment = DeploymentSchema.parse(await readJson(created)).id;
    }
    const status = { state: report.state, description: report.description, environment_url: report.environmentUrl, log_url: report.logUrl };
    await throwOn(await fetchFn(`${base}/deployments/${deployment}/statuses`, posted(headers, status)), `GitHub refused a status for deployment ${deployment}`);
    return { deploymentId: deployment, url: `${projectPage(project)}/deployments/${encodeURIComponent(report.environment)}` };
};

/** Where a runner is registered at GitHub: the `url` config.sh takes, and the REST path its tokens are minted under. */
export interface RunnerScope {
    // https://github.com/<owner>/<repo>, or https://github.com/<org> for an organisation's runner.
    readonly url: string;
    // `repos/<owner>/<repo>` or `orgs/<org>`.
    readonly api: string;
    readonly account: GitHost;
}

type RunnerTokenKind = "registration" | "remove";

const TokenSchema = z.object({ token: z.string().min(1) });

// GitHub's refusal, in what it means for the person: a token it no longer takes, a token without admin on the
// repository (GitHub answers 404 rather than 403 to a token that may not see the repository's runners), a spent rate
// limit, or anything else, said with its status.
const tokenRefusal = (error: Error, scope: RunnerScope, kind: RunnerTokenKind): ORPCError<string, unknown> => {
    const what = `a runner ${kind === "registration" ? "registration" : "removal"} token for ${scope.url}`;
    if (error instanceof CiRateLimited) {
        return new ORPCError("TOO_MANY_REQUESTS", { message: `GitHub would not mint ${what}: the connection's rate limit is spent until ${new Date(error.until).toISOString()}.` });
    }
    if (error instanceof CiRefused && error.status === 401) {
        return new ORPCError("FORBIDDEN", { message: `GitHub no longer accepts the connected account's token, so it would not mint ${what}: reconnect GitHub under Capabilities.` });
    }
    if (error instanceof CiRefused && (error.status === 403 || error.status === 404)) {
        return new ORPCError("FORBIDDEN", {
            message: `GitHub refused to mint ${what} (${error.status}): the connected GitHub account needs admin on ${scope.api.replace(/^(repos|orgs)\//, "")} (a fine-grained token's "Administration: read and write"). Grant it, or connect an account that has it, then try again.`,
        });
    }
    return new ORPCError("BAD_GATEWAY", { message: `GitHub did not mint ${what}: ${error.message}` });
};

/** GitHub issues this token for an hour. It goes straight to the runner and is never logged or kept. */
export const mintRunnerToken = async (scope: RunnerScope, kind: RunnerTokenKind, fetchFn: FetchFn = fetch): Promise<string> => {
    const url = `${scope.account.apiBase}/${scope.api}/actions/runners/${kind === "registration" ? "registration-token" : "remove-token"}`;
    const what = `github runner ${kind} token`;
    const response = await fetchFn(url, { method: "POST", headers: githubHeaders(scope.account.token) })
        .then(async (answer) => await throwOn(answer, what))
        .catch((error: Error) => {
            throw tokenRefusal(error, scope, kind);
        });
    const minted = parseJsonWith(await response.text(), TokenSchema);
    if (minted === undefined) {
        throw new ORPCError("BAD_GATEWAY", { message: `GitHub answered the ${kind} token request for ${scope.url} without a token.` });
    }
    return minted.token;
};

const githubApi = (project: ForgeProject, path: string): string => `${project.account.apiBase}/repos/${project.project}${path}`;
const githubGet = (fetchFn: FetchFn, project: ForgeProject, path: string): Promise<Response> =>
    fetchFn(githubApi(project, path), { headers: githubHeaders(project.account.token) });

// The run names its workflow by id and its branch; a dispatch starts that workflow on the branch's head.
const githubDispatch = async (fetchFn: FetchFn, project: ForgeProject, runId: number): Promise<void> => {
    const run = await json<{ readonly workflow_id: number; readonly head_branch: string | null }>(
        await githubGet(fetchFn, project, `/actions/runs/${runId}`),
        "github run",
    );
    const dispatches = githubApi(project, `/actions/workflows/${run.workflow_id}/dispatches`);
    await postTo(fetchFn, dispatches, githubHeaders(project.account.token), "github workflow dispatch", { ref: run.head_branch ?? "" });
};

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
    readonly runner_name?: string | null;
}

// One job's check run annotations, as Actions answers them (a job's id is its check run's).
const annotationsAsked = (fetchFn: FetchFn, project: ForgeProject, jobId: number): Promise<Response> =>
    fetchFn(githubApi(project, `/check-runs/${jobId}/annotations`), { headers: githubHeaders(project.account.token) });

// Settled once every job has completed; an empty list is a run whose jobs have not been made yet.
const githubJobLists = jobLists<GithubJob>((jobs) => jobs.length > 0 && jobs.every((job) => job.status === "completed"));

// What a sandbox's hook on a GitHub repository delivers: each finished run, and each finished job, so a failure is heard
// the moment its job fails rather than when the whole run does.
const GITHUB_HOOK_EVENTS = ["workflow_run", "workflow_job"];

// Called workflow files read for one run's graph, at most.
const CALLED_FILES_READ = 40;

export const githubClient = (fetchFn: FetchFn): ForgeClient => {
    // Resolves the run's workflow file at its exact sha, not HEAD, so an old run isn't drawn with the wrong graph; a
    // file of another repository is read from it, at the ref its call pins. Undefined, never a throw, for any
    // legitimate empty case; the graph is enrichment only.
    const fileAt = async (project: ForgeProject, path: string, ref: string, repo = project.project): Promise<string | undefined> => {
        // `.raw` hands back the file itself; the default json media type would wrap it in base64.
        const file = await fetchFn(`${project.account.apiBase}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
            headers: { ...githubHeaders(project.account.token), Accept: "application/vnd.github.raw" },
        });
        return file.ok ? await file.text() : undefined;
    };
    // A called file by the key workflowCalls named it with: a path in the run's repository, or another's call.
    const calledFile = (project: ForgeProject, key: string, ref: string): Promise<string | undefined> => {
        const remote = remoteWorkflow(key);
        return remote === undefined ? fileAt(project, key, ref) : fileAt(project, remote.path, remote.ref, remote.repo);
    };
    const workflowSource = async (project: ForgeProject, runId: number): Promise<WorkflowSource | undefined> => {
        const cacheKey = runKey(project, runId);
        const remembered = workflowSources.get(cacheKey);
        if (remembered !== undefined) {
            return remembered;
        }
        const runResponse = await fetchFn(githubApi(project, `/actions/runs/${runId}`), { headers: githubHeaders(project.account.token) });
        if (!runResponse.ok) {
            return undefined;
        }
        const run = await readJson<{ path?: string; head_sha?: string }>(runResponse);
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
    const post = (project: ForgeProject, path: string, what: string, body?: ForgeBody): Promise<void> =>
        postTo(fetchFn, githubApi(project, path), githubHeaders(project.account.token), what, body);
    const listJobs = (project: ForgeProject, runId: number, what: string) => async (): Promise<GithubJob[]> =>
        (
            await json<{ jobs: GithubJob[] }>(
                await fetchFn(githubApi(project, `/actions/runs/${runId}/jobs?per_page=100`), { headers: githubHeaders(project.account.token) }),
                what,
            )
        ).jobs;
    const jobListOf = (project: ForgeProject, runId: number): Promise<GithubJob[]> =>
        githubJobLists.kept(fetchFn, runKey(project, runId), listJobs(project, runId, "github jobs list"));
    // A fix's reading, which takes the list the board's row just read (githubJobLists) rather than waiting on it again:
    // every job that failed, and every cancelled one whose cancel says it failed after all, in the run's order.
    const jobsOf = async (project: ForgeProject, runId: number): Promise<FailedStep[]> => {
        const listed = await jobListOf(project, runId);
        const annotated = await jobAnnotations(listed, runKey(project, 0), (jobId) => annotationsAsked(fetchFn, project, jobId));
        return listed.flatMap((job) => githubFailedStep(job, annotated.get(job)));
    };
    // Redirects to a short-lived blob url; fetch follows it. An expired log is reported inline, not fatal.
    const logOf = async (project: ForgeProject, jobId: number, maxBytes: number): Promise<string> => {
        const response = await fetchFn(githubApi(project, `/actions/jobs/${jobId}/logs`), { headers: githubHeaders(project.account.token) });
        return (response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`).slice(-maxBytes);
    };
    return {
        createRepository: (host, name, owner, warn) => createRepository(host, name, owner, warn, fetchFn),
        reportDeployment: (project, report) => reportDeployment(fetchFn, project, report),
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
        // No `stage`: Actions has no such concept. The jobs as the run reports them; the board's backend draws their graph
        // from the workflow file (`workflowSource`).
        allJobs: async (project, runId) => {
            const listed = await githubJobLists.read(fetchFn, runKey(project, runId), listJobs(project, runId, "github all jobs"));
            return listed.map((job) => {
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
        },
        workflowSource,
        jobLog: (project, jobId, maxBytes) => logOf(project, jobId, maxBytes),
        // A re-run makes the run's jobs anew, so the list kept for it no longer describes it.
        rerun: (project, runId) => {
            githubJobLists.forget(fetchFn, runKey(project, runId));
            return post(project, `/actions/runs/${runId}/rerun`, "github rerun");
        },
        rerunFailed: (project, runId) => {
            githubJobLists.forget(fetchFn, runKey(project, runId));
            return post(project, `/actions/runs/${runId}/rerun-failed-jobs`, "github rerun failed jobs");
        },
        annotations: async (project, jobId) => (await annotationsOf(await annotationsAsked(fetchFn, project, jobId))) ?? [],
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
