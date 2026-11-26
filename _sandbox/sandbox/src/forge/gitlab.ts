import { errorMessage } from "@intentic/base/errors";
import { plainText } from "@intentic/base/plain-text";
import type { CiDeploymentAnswer, CiDeploymentReport, PipelineJob } from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";
import type { GitHost } from "../capabilities/cli/git-access.js";
import type { ForgeClient } from "./client.js";
import { type FetchFn, type ForgeBody, gitlabHeaders, json, posted, postTo, readJson } from "./http.js";
import { jobLists, runKey } from "./job-lists.js";
import { type ForgeProject, GitlabProjectError, projectPage } from "./projects.js";
import { throwOn } from "./refusals.js";
import { epoch, type GitlabPipeline, type GitlabRunMeta, gitlabRun, gitlabStatus } from "./runs.js";

const GitlabProjectSchema = z.object({ id: z.number(), path_with_namespace: z.string(), default_branch: z.string().nullish() });

// Creating the project a publish pushes /work into, on a GitLab instance. GitLab answers a create in a namespace the
// token may not use with a bare 400 {"namespace":["is not valid"]}, which is what a group or project access token got
// here: its bot user has a personal namespace nobody may create projects in (2026-10-26, a project token on a
// self-hosted 18.6). So the namespace is chosen first: the one the owner named, else the token's own for a person, else
// the group a group token belongs to; a project token can create nothing, and says so with the project it can push to.

const UserSchema = z.object({ bot: z.boolean().optional() });
const NamespaceSchema = z.object({ id: z.number(), full_path: z.string() });
const NamespacesSchema = z.array(NamespaceSchema);
const ProjectsSchema = z.array(z.object({ path_with_namespace: z.string() }));
const CreatedSchema = z.object({ path_with_namespace: z.string().optional(), http_url_to_repo: z.string().optional() });

// Developer: the least a member needs to create a project in a group under GitLab's default creation setting.
const DEVELOPER = 30;

// The instance's own address (the card's url), which the token's credential line was written for.
const instanceBase = (host: GitHost): string => host.apiBase.replace(/\/api\/v4$/u, "");

// GitLab's own words for a refusal; a body that cannot be read says why instead.
const bodyText = async (response: Response): Promise<string> => {
    try {
        return await response.text();
    } catch (error) {
        return `(its answer could not be read: ${errorMessage(error)})`;
    }
};

// A body parsed as JSON, or why it could not be: the caller names the failure rather than meeting an empty object.
const jsonBody = async (response: Response): Promise<{ readonly value: unknown } | { readonly unreadable: string }> => {
    try {
        return { value: await readJson(response) };
    } catch (error) {
        return { unreadable: errorMessage(error) };
    }
};

const refused = async (host: GitHost, what: string, response: Response): Promise<GitlabProjectError> =>
    new GitlabProjectError(`${host.host} refused ${what}: ${response.status} ${await bodyText(response)}`.trim());

const getJson = async <T>(host: GitHost, fetcher: FetchFn, path: string, schema: z.ZodType<T>, what: string): Promise<T> => {
    const response = await fetcher(`${host.apiBase}${path}`, { headers: gitlabHeaders(host.token) });
    if (!response.ok) {
        throw await refused(host, what, response);
    }
    const body = await jsonBody(response);
    if ("unreadable" in body) {
        throw new GitlabProjectError(`${host.host} answered ${what} with something that is not JSON: ${body.unreadable}`);
    }
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
        throw new GitlabProjectError(`${host.host} answered ${what} with something that is not GitLab's shape`);
    }
    return parsed.data;
};

// Where the project goes: undefined is the token's own personal namespace, which only a person's token may use.
const namespaceFor = async (host: GitHost, owner: string | undefined, fetcher: FetchFn): Promise<number | undefined> => {
    if (owner !== undefined) {
        const response = await fetcher(`${host.apiBase}/namespaces/${encodeURIComponent(owner)}`, { headers: gitlabHeaders(host.token) });
        if (response.status === 404) {
            throw new GitlabProjectError(`${host.host} has no group or user "${owner}" this token can see`);
        }
        if (!response.ok) {
            throw await refused(host, `to look up "${owner}"`, response);
        }
        return NamespaceSchema.parse(await readJson(response)).id;
    }
    const user = await getJson(host, fetcher, "/user", UserSchema, "to say whose token this is");
    if (user.bot !== true) {
        return undefined;
    }
    const groups = await getJson(host, fetcher, `/groups?min_access_level=${String(DEVELOPER)}&per_page=100`, NamespacesSchema, "to list its groups");
    const group = groups.toSorted((a, b) => a.full_path.length - b.full_path.length || a.full_path.localeCompare(b.full_path))[0];
    if (group !== undefined) {
        return group.id;
    }
    const projects = await getJson(host, fetcher, "/projects?membership=true&per_page=20", ProjectsSchema, "to list its projects");
    const reach = projects.length === 0 ? "" : ` It can push to ${projects.map((project) => project.path_with_namespace).join(", ")}.`;
    throw new GitlabProjectError(
        `the GitLab card's token is a project access token, which GitLab does not let create projects.${reach} To publish, ` +
            `create an empty project on ${host.host} and paste its URL, or connect a personal or group access token with the api scope.`,
    );
};

// POST /projects as GitLab reads it; no namespace_id is the token's own personal namespace.
type GitlabCreateRequest = {
    readonly name: string;
    readonly path: string;
    readonly visibility: "private";
    namespace_id?: number;
};

/** Creates a private project for the workspace and answers its clone URL on the card's own address. */
const createRepository = async (host: GitHost, name: string, owner: string | undefined, fetcher: FetchFn): Promise<string> => {
    const namespaceId = await namespaceFor(host, owner, fetcher);
    const request: GitlabCreateRequest = { name, path: name, visibility: "private" };
    if (namespaceId !== undefined) {
        request.namespace_id = namespaceId;
    }
    const response = await fetcher(`${host.apiBase}/projects`, posted(gitlabHeaders(host.token), request));
    if (!response.ok) {
        throw await refused(host, `to create "${name}"`, response);
    }
    const answer = await jsonBody(response);
    if ("unreadable" in answer) {
        throw new GitlabProjectError(`${host.host} created "${name}" but its answer is not JSON (${answer.unreadable}); the project may exist there now`);
    }
    const body = CreatedSchema.safeParse(answer.value).data ?? {};
    // GitLab spells its clone URL from its own external_url, which need not be the address this sandbox reaches it at
    // (and holds the credential for); the project's path on the card's address is the same repository.
    if (body.path_with_namespace !== undefined && body.path_with_namespace !== "") {
        return `${instanceBase(host)}/${body.path_with_namespace}.git`;
    }
    if (body.http_url_to_repo !== undefined && body.http_url_to_repo !== "") {
        return body.http_url_to_repo;
    }
    throw new GitlabProjectError(`${host.host} created the project but returned no clone URL`);
};

// GitLab's words for GitHub's states.
const GITLAB_STATES = {
    in_progress: "running",
    success: "success",
    failure: "failed",
    inactive: "canceled",
} as const satisfies Readonly<Record<CiDeploymentReport["state"], string>>;

const reportDeployment = async (fetchFn: FetchFn, project: ForgeProject, report: CiDeploymentReport): Promise<CiDeploymentAnswer> => {
    const url = gitlabApi(project, `/statuses/${report.sha}`);
    const status = { state: GITLAB_STATES[report.state], name: `deploy/${report.environment}`, description: report.description, target_url: report.logUrl };
    await throwOn(await fetchFn(url, posted(gitlabHeaders(project.account.token), status)), "GitLab refused a commit status");
    return { url: `${projectPage(project)}/-/commit/${report.sha}` };
};

const gitlabApi = (project: ForgeProject, path: string): string => `${project.account.apiBase}/projects/${encodeURIComponent(project.project)}${path}`;

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

const gitlabPipelineOf = async (fetchFn: FetchFn, project: ForgeProject, runId: number): Promise<GitlabPipeline> =>
    json<GitlabPipeline>(await fetchFn(gitlabApi(project, `/pipelines/${runId}`), { headers: gitlabHeaders(project.account.token) }), "gitlab pipeline");

const gitlabPassedJobs = async (fetchFn: FetchFn, project: ForgeProject, runId: number): Promise<string[]> =>
    (
        await json<{ readonly name: string }[]>(
            await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?scope[]=success&per_page=100`), { headers: gitlabHeaders(project.account.token) }),
            "gitlab passed jobs",
        )
    ).map((job) => job.name);

const gitlabJobLog = async (fetchFn: FetchFn, project: ForgeProject, jobId: number, maxBytes: number): Promise<string> => {
    const response = await fetchFn(gitlabApi(project, `/jobs/${jobId}/trace`), { headers: gitlabHeaders(project.account.token) });
    return (response.ok ? plainText(await response.text()) : `(log unavailable: ${response.status})`).slice(-maxBytes);
};

export const gitlabClient = (fetchFn: FetchFn): ForgeClient => {
    // Enrichment never fails the listing; every catch here is a deliberate swallow, not a rethrow.
    const metaFromJobs = async (project: ForgeProject): Promise<Map<number, GitlabRunMeta>> => {
        const byPipeline = new Map<number, GitlabRunMeta>();
        try {
            const jobs = await json<GitlabProjectJob[]>(
                await fetchFn(gitlabApi(project, `/jobs?per_page=${GITLAB_JOB_SCAN}`), { headers: gitlabHeaders(project.account.token) }),
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
    const commitsBySha = async (project: ForgeProject): Promise<Map<string, GitlabCommit>> => {
        try {
            const commits = await json<GitlabCommit[]>(
                await fetchFn(gitlabApi(project, `/repository/commits?all=true&per_page=${GITLAB_COMMIT_SCAN}`), { headers: gitlabHeaders(project.account.token) }),
                "gitlab commits list",
            );
            return new Map(commits.map((commit) => [commit.id, commit]));
        } catch {
            return new Map();
        }
    };

    const post = (project: ForgeProject, path: string, what: string, body?: ForgeBody): Promise<void> =>
        postTo(fetchFn, gitlabApi(project, path), gitlabHeaders(project.account.token), what, body);
    // A job allowed to fail fails nothing, so it is none of the pipeline's failures. Shared by a fix's three readings of
    // it (gitlabFailedLists), never kept: a failed-only list cannot say whether the pipeline is still going.
    const failedJobsOf = async (project: ForgeProject, runId: number): Promise<GitlabFailedJob[]> =>
        (
            await gitlabFailedLists.kept(fetchFn, runKey(project, runId), async () =>
                json<GitlabFailedJob[]>(
                    await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?scope[]=failed&per_page=100`), { headers: gitlabHeaders(project.account.token) }),
                    "gitlab jobs list",
                ),
            )
        ).filter((job) => job.allow_failure !== true);
    return {
        createRepository: (host, name, owner) => createRepository(host, name, owner, fetchFn),
        reportDeployment: (project, report) => reportDeployment(fetchFn, project, report),
        listRuns: async (project, limit) => {
            const listed = await json<GitlabPipeline[]>(
                await fetchFn(gitlabApi(project, `/pipelines?per_page=${limit}`), { headers: gitlabHeaders(project.account.token) }),
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
            >(await fetchFn(gitlabApi(project, `/pipelines/${runId}/jobs?per_page=100`), { headers: gitlabHeaders(project.account.token) }), "gitlab all jobs");
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
        workflowSource: async () => undefined,
        jobLog: (project, jobId, maxBytes) => gitlabJobLog(fetchFn, project, jobId, maxBytes),
        rerun: (project, runId) => post(project, `/pipelines/${runId}/retry`, "gitlab retry"),
        // GitLab's retry runs only the failed jobs again, and it has no annotations: its `failure_reason` says what the fleet did.
        rerunFailed: (project, runId) => post(project, `/pipelines/${runId}/retry`, "gitlab retry"),
        annotations: async () => [],
        cancel: (project, runId) => post(project, `/pipelines/${runId}/cancel`, "gitlab cancel"),
        ensureHook: async (project, spec) => {
            const hooks = await json<{ id: number; url: string; job_events?: boolean }[]>(
                await fetchFn(gitlabApi(project, "/hooks"), { headers: gitlabHeaders(project.account.token) }),
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
                        headers: { ...gitlabHeaders(project.account.token), "Content-Type": "application/json" },
                        body: JSON.stringify(settings),
                    }),
                    "gitlab hook update",
                );
            }
        },
        removeHook: async (project, url) => {
            const hooks = await json<{ id: number; url: string }[]>(
                await fetchFn(gitlabApi(project, "/hooks"), { headers: gitlabHeaders(project.account.token) }),
                "gitlab hooks list",
            );
            for (const hook of hooks.filter((candidate) => candidate.url === url)) {
                await throwOn(
                    await fetchFn(gitlabApi(project, `/hooks/${hook.id}`), { method: "DELETE", headers: gitlabHeaders(project.account.token) }),
                    "gitlab hook delete",
                );
            }
        },
        repository: async (project) => {
            const repo = GitlabProjectSchema.parse(
                await json<unknown>(await fetchFn(gitlabApi(project, ""), { headers: gitlabHeaders(project.account.token) }), "gitlab project"),
            );
            return { id: repo.id, path: repo.path_with_namespace, defaultBranch: repo.default_branch ?? undefined };
        },
        projectUrl: (project) => `${project.account.apiBase.replace(/\/api\/v4$/, "")}/${project.project}`,
    };
};
