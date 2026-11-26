import { createHmac } from "node:crypto";
import { keyedLock } from "@intentic/base/async";
import type { CiFeedEvent, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { dispatchCiRun } from "./events.js";
import { jobFailed } from "./main-fixer.js";
import type { FailedJob } from "./main-streak.js";
import {
    ciClientFor,
    type FetchFn,
    type GithubRun,
    githubRun,
    githubStatus,
    type GitlabPipelineHook,
    gitlabHookRun,
    gitlabStatus,
} from "./providers.js";
import { ciFeedRoute, publishCiFeed } from "./feed/ci-feed.js";
import { opt } from "../opt.js";
import { forgeOf } from "./main-line.js";
import { ciProjects, type CiProject } from "./projects.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { readBoundedText } from "../http/bounded-body.js";

// Public webhook receiver, gated by the per-sandbox secret (github HMACs the body, gitlab echoes it as a token); one
// route for both vendors. An unmapped project's delivery is acknowledged and dropped, not an error. Verifies the sender
// and normalizes into a PipelineRun, or a failed job; what a finished run means is ci/events.ts, shared with the poller,
// and a failed job goes to main's fix agent (main-fixer.ts). Either is answered as soon as it is understood, and what
// it sets going runs off the delivery's clock: GitHub calls a delivery failed that takes ten seconds to answer, and one
// run's failed jobs read and dispatched inline took a minute.

interface GithubDelivery {
    readonly action?: string;
    readonly workflow_run?: GithubRun & { readonly actor?: { readonly login?: string } };
    readonly workflow_job?: GithubJob;
    readonly repository?: GithubRepository;
}

// Every delivery's repository: its stable id, its name now, and its default branch.
interface GithubRepository {
    readonly id?: number;
    readonly full_name?: string;
    readonly default_branch?: string | null;
}

// A `workflow_job` delivery's job, narrowed to what a failure needs.
interface GithubJob {
    readonly id: number;
    readonly run_id: number;
    readonly name: string;
    readonly workflow_name?: string | null;
    readonly head_branch?: string | null;
    readonly head_sha?: string;
    readonly html_url?: string | null;
    readonly conclusion?: string | null;
    readonly steps?: readonly { readonly name: string; readonly conclusion?: string | null }[];
    readonly runner_name?: string | null;
}

// A `Job Hook` delivery, narrowed the same way.
interface GitlabJobHook {
    readonly build_id: number;
    readonly pipeline_id: number;
    readonly build_name: string;
    readonly build_status: string;
    readonly build_allow_failure?: boolean;
    readonly build_failure_reason?: string;
    readonly ref: string;
    readonly tag?: boolean;
    readonly sha?: string;
    readonly project: { readonly id?: number; readonly path_with_namespace: string; readonly web_url?: string; readonly default_branch?: string | null };
}

// What a delivery says of the repository it is about, whichever forge and event sent it.
interface Sender {
    readonly path: string;
    readonly id?: number | undefined;
    readonly defaultBranch?: string | undefined;
}

const githubSender = (repository: GithubRepository | undefined): Sender | undefined =>
    repository?.full_name === undefined
        ? undefined
        : { path: repository.full_name, id: repository.id, defaultBranch: repository.default_branch ?? undefined };

const gitlabSender = (project: { readonly id?: number; readonly path_with_namespace: string; readonly default_branch?: string | null }): Sender => ({
    path: project.path_with_namespace,
    id: project.id,
    defaultBranch: project.default_branch ?? undefined,
});

// The workspace repo a delivery is about. The forge's id decides where the reconcile learned it (hooks.ts): a rename or a
// transfer changes the path every delivery carries, while the remote and the API keep working through redirects, so a
// match on the path alone would drop every delivery without a word. The path is the fallback for a repository whose id
// is not known yet.
const projectOf = async (services: Services, host: "github" | "gitlab", sender: Sender): Promise<CiProject | undefined> => {
    const candidates = (await ciProjects(services)).filter((candidate) => candidate.account.provider === host);
    if (sender.id !== undefined) {
        const forges = await services.ciStore.forges();
        const known = candidates.find((candidate) => forgeOf(forges, candidate)?.id === sender.id);
        if (known !== undefined) {
            return known;
        }
    }
    const wanted = sender.path.toLowerCase();
    return candidates.find((candidate) => candidate.project.toLowerCase() === wanted);
};

// A job that failed, as main's fix agent hears of it; undefined for any other phase or outcome, and for a GitLab job
// allowed to fail, which fails nothing.
const githubFailedJob = (job: GithubJob): FailedJob | undefined => {
    if (job.conclusion === undefined || job.conclusion === null || githubStatus("completed", job.conclusion) !== "failed") {
        return undefined;
    }
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name);
    return {
        runId: job.run_id,
        jobId: job.id,
        name: job.name,
        branch: job.head_branch ?? "",
        workflow: job.workflow_name ?? undefined,
        sha: job.head_sha,
        url: job.html_url ?? undefined,
        step: steps[0],
        steps,
        runner: job.runner_name ?? undefined,
    };
};

const gitlabFailedJob = (hook: GitlabJobHook): FailedJob | undefined =>
    hook.build_status !== "failed" || hook.build_allow_failure === true || hook.tag === true
        ? undefined
        : {
              runId: hook.pipeline_id,
              jobId: hook.build_id,
              name: hook.build_name,
              branch: hook.ref,
              sha: hook.sha,
              url: hook.project.web_url === undefined ? undefined : `${hook.project.web_url}/-/jobs/${hook.build_id}`,
              reason: hook.build_failure_reason,
          };

// A job that ended, passed or failed, as the CI feed tells a program of it (feed/ci-feed.ts): the Deployments extension
// deploys the moment the job publishing its images passes, before the rest of its run ends. Only the forge's own
// verdicts: a job still going is not one, and a GitLab tag's job names no branch.
type CompletedJob = Omit<Extract<CiFeedEvent, { kind: "job" }>, "kind" | "repo" | "project">;

const githubCompletedJob = (job: GithubJob, webBase: string): CompletedJob | undefined =>
    job.conclusion === undefined || job.conclusion === null || job.head_sha === undefined || job.head_branch === undefined || job.head_branch === null
        ? undefined
        : {
              host: "github",
              runId: job.run_id,
              ...opt("workflow", job.workflow_name ?? undefined),
              job: job.name,
              branch: job.head_branch,
              sha: job.head_sha,
              status: githubStatus("completed", job.conclusion),
              url: job.html_url ?? `${webBase}/actions/runs/${job.run_id}/job/${job.id}`,
          };

const GITLAB_ENDED: ReadonlySet<string> = new Set(["success", "failed", "canceled", "skipped"]);

const gitlabCompletedJob = (hook: GitlabJobHook, webBase: string): CompletedJob | undefined =>
    !GITLAB_ENDED.has(hook.build_status) || hook.tag === true || hook.sha === undefined
        ? undefined
        : {
              host: "gitlab",
              runId: hook.pipeline_id,
              job: hook.build_name,
              branch: hook.ref,
              sha: hook.sha,
              status: gitlabStatus(hook.build_status),
              url: `${hook.project.web_url ?? webBase}/-/jobs/${hook.build_id}`,
          };

// A run as the board and the automations hear of it, at every phase: what failed in it read first, so the wake payload
// and the view name what broke (a failure of that read degrades to names-less), then cached, announced and, once it has
// a result, dispatched.
const announceRun = async (
    services: Services,
    host: "github" | "gitlab",
    project: CiProject,
    delivered: PipelineRun,
    author: { id: string; name: string },
    fetchFn: FetchFn,
): Promise<void> => {
    let run = delivered;
    if (run.status === "failed") {
        const failedJobs = await ciClientFor(host, fetchFn)
            .failedJobs(project, run.runId)
            .catch(() => []);
        run = failedJobs.length > 0 ? { ...run, failedJobs } : run;
    }
    services.ciRuns.upsert(run);
    // Every delivery, in-flight or finished, is when the board and CI-shaped watches learn a run moved (2026-10-20).
    publishRuntimeChange("ci");
    // Main's fix agent reads the run on its own clock: `fixed` is left to settle by itself. A run still in flight
    // dispatches nothing: automations and the fix agent hear a result only (ciResultOf).
    await dispatchCiRun(services, project, run, author, fetchFn);
};

// What a delivery says: who sent it, and a run normalizer or a job that moved (failed, perhaps); undefined for a ping or an
// unconsumed event. Every phase counts (2026-10-20): an open board and a CI-shaped watch learn of a run moving from
// these, where they once heard only of runs that ended.
interface Understood {
    readonly sender: Sender;
    readonly author: { readonly id: string; readonly name: string };
    readonly toRun?: (project: { repo: string; project: string }) => PipelineRun;
    readonly jobMoved: boolean;
    readonly failedJob?: FailedJob | undefined;
    // A job that ended, for the CI feed; its URL is the forge's, or built from the project's page once that is known.
    readonly completedJob?: ((webBase: string) => CompletedJob | undefined) | undefined;
}

const githubDeliveryOf = (event: string | undefined, delivery: GithubDelivery): Understood | undefined => {
    const sender = githubSender(delivery.repository);
    if (sender === undefined) {
        return undefined;
    }
    if (event === "workflow_job" && delivery.workflow_job !== undefined) {
        const job = delivery.workflow_job;
        return {
            sender,
            author: { id: "github", name: "github" },
            jobMoved: true,
            failedJob: delivery.action === "completed" ? githubFailedJob(job) : undefined,
            completedJob: delivery.action === "completed" ? (webBase) => githubCompletedJob(job, webBase) : undefined,
        };
    }
    if (event === "workflow_run" && delivery.workflow_run !== undefined) {
        const run = delivery.workflow_run;
        const login = run.actor?.login;
        return {
            sender,
            author: login === undefined ? { id: "github", name: "github" } : { id: login, name: login },
            toRun: (project) => githubRun(project, run),
            jobMoved: false,
        };
    }
    return undefined;
};

const gitlabDeliveryOf = (event: string | undefined, payload: Partial<GitlabJobHook> | Partial<GitlabPipelineHook>): Understood | undefined => {
    if (event === "Job Hook") {
        const delivery = payload as Partial<GitlabJobHook>;
        if (delivery.project === undefined || typeof delivery.build_id !== "number" || typeof delivery.pipeline_id !== "number") {
            return undefined;
        }
        const hook = delivery as GitlabJobHook;
        return {
            sender: gitlabSender(delivery.project),
            author: { id: "gitlab", name: "gitlab" },
            jobMoved: true,
            failedJob: gitlabFailedJob(hook),
            completedJob: (webBase) => gitlabCompletedJob(hook, webBase),
        };
    }
    const delivery = payload as Partial<GitlabPipelineHook>;
    if (event !== "Pipeline Hook" || delivery.object_attributes === undefined || delivery.project === undefined) {
        return undefined;
    }
    const user = delivery.user;
    return {
        sender: gitlabSender(delivery.project),
        author:
            user?.name !== undefined || user?.username !== undefined
                ? { id: user.username ?? user.name ?? "gitlab", name: user.name ?? user.username ?? "gitlab" }
                : { id: "gitlab", name: "gitlab" },
        toRun: (project) => gitlabHookRun(project, delivery as GitlabPipelineHook),
        jobMoved: false,
    };
};

// A job that ended, handed on: to the CI feed, passed or failed, and a failure to main's fix agent off the delivery's
// clock (reading its log and starting or telling the agent takes a while). Whether the delivery was one.
const handedOffJob = (services: Services, project: CiProject, understood: Understood, fetchFn: FetchFn): boolean => {
    const { failedJob } = understood;
    const completed = understood.completedJob?.(`${project.account.scheme}://${project.account.host}/${project.project}`);
    if (completed !== undefined) {
        publishCiFeed({ kind: "job", ...completed, repo: project.repo, project: project.project });
    }
    if (failedJob !== undefined) {
        void jobFailed(services, project, failedJob, fetchFn).catch((error: unknown) =>
            services.logger.warn({ err: error, repo: project.repo, jobId: failedJob.jobId }, "ci repair: the failed job could not be handled"),
        );
    }
    return completed !== undefined || failedJob !== undefined;
};

// Ample room for a workflow run or job delivery, while bounding the memory an unauthenticated caller can make the
// daemon allocate before the HMAC or token check.
export const CI_WEBHOOK_PAYLOAD_MAX = 1024 * 1024;

export const createCiWebhookRoute = (services: Services, fetchFn: FetchFn = fetch) => {
    // One repository's runs are announced in the order their deliveries arrived, each after the last has finished:
    // whether a run broke or fixed its branch is read against the conclusion the run before it recorded.
    const inOrder = keyedLock<string>();
    return async (c: Context<AppEnv, "/ci/webhook/:host">): Promise<Response> => {
        const host = c.req.param("host");
        if (host !== "github" && host !== "gitlab") {
            return c.json({ error: "unknown host" }, 404);
        }
        // Count the bytes as they arrive: a public caller must not make the daemon hold an unbounded body before its
        // signature or token is checked, and a chunked delivery has no Content-Length to check up front.
        const body = await readBoundedText(c.req.raw, CI_WEBHOOK_PAYLOAD_MAX);
        if (body.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        if (body.kind === "invalid") {
            return c.json({ error: "invalid payload" }, 400);
        }
        const raw = body.value;
        const secret = await services.ciStore.secret();
        if (host === "github") {
            const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
            if (!tokenEquals(c.req.header("x-hub-signature-256") ?? "", expected)) {
                return c.json({ error: "bad signature" }, 401);
            }
        } else if (!tokenEquals(c.req.header("x-gitlab-token") ?? "", secret)) {
            return c.json({ error: "bad token" }, 401);
        }
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            return c.json({ error: "invalid payload" }, 400);
        }

        // SAFETY: the body is the forge's signed or token-gated delivery; every field the readers use is checked for
        // presence before use, so a partial shape is all the cast claims.
        const understood =
            host === "github"
                ? githubDeliveryOf(c.req.header("x-github-event"), payload as GithubDelivery)
                : gitlabDeliveryOf(c.req.header("x-gitlab-event"), payload as Partial<GitlabJobHook> | Partial<GitlabPipelineHook>);
        if (understood === undefined) {
            return c.json({ ok: true, ignored: true });
        }
        const { sender, author, toRun, jobMoved } = understood;

        const project = await projectOf(services, host, sender);
        if (project === undefined) {
            return c.json({ ok: true, ignored: true });
        }
        // Every delivery says it again, so a default branch changed on the forge reaches main's fix agent with the next
        // one; written only when it says something new.
        try {
            await services.ciStore.learnForge(project.repo, project.project, { id: sender.id, path: sender.path, defaultBranch: sender.defaultBranch });
        } catch (error) {
            services.logger.warn({ err: error, repo: project.repo }, "ci: what the delivery said of its repository was not kept");
        }
        if (jobMoved) {
            // A job's phase is not in the runs cache, but an open run's job graph and a watch on it read it fresh.
            publishRuntimeChange("ci");
        }
        if (handedOffJob(services, project, understood, fetchFn)) {
            return c.json({ ok: true });
        }
        if (toRun === undefined) {
            return c.json({ ok: true, ignored: true });
        }
        // Off the delivery's clock, like a failed job.
        const run = toRun(project);
        void inOrder(project.repo, async () => {
            try {
                await announceRun(services, host, project, run, author, fetchFn);
            } catch (error) {
                services.logger.error({ err: error, repo: project.repo, runId: run.runId }, "ci: the finished run could not be announced");
            }
        });
        return c.json({ ok: true });
    };
};

// CI webhook receiver, secret-gated in the handler; completed pipelines wake `ci` listener automations. Beside it, what it
// heard as a stream for programs (feed/ci-feed.ts): an extension reaches it by declaring `GET /ci/feed` in its
// `permissions.daemon`, and no agent or panel token does (protocol/raw/raw-routes.ts).
export const ciWebhookRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /ci/webhook/{host}": createCiWebhookRoute(services),
    "GET /ci/feed": ciFeedRoute(),
}));
