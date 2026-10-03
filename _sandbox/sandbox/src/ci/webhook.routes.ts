import { createHmac } from "node:crypto";
import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { dispatchCiRun } from "./events.js";
import { type FailedJob, jobFailed } from "./main-fixer.js";
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
import { forgeOf } from "./main-line.js";
import { ciProjects, type CiProject } from "./projects.js";

// Public webhook receiver, gated by the per-sandbox secret (github HMACs the body, gitlab echoes it as a token); one
// route for both vendors. An unmapped project's delivery is acknowledged and dropped, not an error. Verifies the sender
// and normalizes into a PipelineRun, or a failed job; what a finished run means is ci/events.ts, shared with the poller,
// and a failed job goes to main's fix agent (main-fixer.ts).

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

export const createCiWebhookRoute =
    (services: Services, fetchFn: FetchFn = fetch) =>
    async (c: Context<AppEnv, "/ci/webhook/:host">): Promise<Response> => {
        const host = c.req.param("host");
        if (host !== "github" && host !== "gitlab") {
            return c.json({ error: "unknown host" }, 404);
        }
        const raw = await c.req.text();
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

        // The sender plus a run normalizer or a failed job; undefined for a ping, an in-progress phase, or an unconsumed
        // event.
        let sender: Sender | undefined;
        let author = { id: host, name: host };
        let toRun: ((project: { repo: string; project: string }) => PipelineRun) | undefined;
        let failedJob: FailedJob | undefined;
        if (host === "github") {
            const delivery = payload as GithubDelivery;
            if (c.req.header("x-github-event") === "workflow_job" && delivery.action === "completed" && delivery.workflow_job !== undefined) {
                sender = githubSender(delivery.repository);
                failedJob = githubFailedJob(delivery.workflow_job);
            } else if (c.req.header("x-github-event") === "workflow_run" && delivery.action === "completed" && delivery.workflow_run !== undefined) {
                const run = delivery.workflow_run;
                sender = githubSender(delivery.repository);
                author = run.actor?.login !== undefined ? { id: run.actor.login, name: run.actor.login } : author;
                toRun = (project) => githubRun(project, run);
            }
        } else if (c.req.header("x-gitlab-event") === "Job Hook") {
            const delivery = payload as Partial<GitlabJobHook>;
            if (delivery.project !== undefined && typeof delivery.build_id === "number" && typeof delivery.pipeline_id === "number") {
                sender = gitlabSender(delivery.project);
                failedJob = gitlabFailedJob(delivery as GitlabJobHook);
            }
        } else {
            const delivery = payload as Partial<GitlabPipelineHook>;
            if (
                c.req.header("x-gitlab-event") === "Pipeline Hook" &&
                delivery.object_attributes !== undefined &&
                delivery.project !== undefined &&
                // Fires at every phase; gates on "not in flight", not "not running" since queued is neither.
                !isPipelineInFlight(gitlabStatus(delivery.object_attributes.status))
            ) {
                sender = gitlabSender(delivery.project);
                const user = delivery.user;
                author =
                    user?.name !== undefined || user?.username !== undefined
                        ? { id: user.username ?? user.name ?? host, name: user.name ?? user.username ?? host }
                        : author;
                toRun = (project) => gitlabHookRun(project, delivery as GitlabPipelineHook);
            }
        }
        if (sender === undefined || (toRun === undefined && failedJob === undefined)) {
            return c.json({ ok: true, ignored: true });
        }

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
        if (failedJob !== undefined) {
            // Off the delivery's clock: reading the job's log and starting or telling the fix agent takes a while.
            const job = failedJob;
            void jobFailed(services, project, job, fetchFn).catch((error: unknown) =>
                services.logger.warn({ err: error, repo: project.repo, jobId: job.jobId }, "ci repair: the failed job could not be handled"),
            );
            return c.json({ ok: true });
        }
        if (toRun === undefined) {
            return c.json({ ok: true, ignored: true });
        }

        let run = toRun(project);
        if (run.status === "failed") {
            // One extra call so the wake payload and the view name what broke; a failure here degrades to names-less.
            const failedJobs = await ciClientFor(host, fetchFn)
                .failedJobs(project, run.runId)
                .catch(() => []);
            run = failedJobs.length > 0 ? { ...run, failedJobs } : run;
        }
        services.ciRuns.upsert(run);
        // The delivery is the only moment the daemon knows a run ended; without this an open board waits out its poll.
        publishRuntimeChange("ci");
        // Main's fix agent reads the run off the delivery's clock: `fixed` is left to settle by itself.
        await dispatchCiRun(services, project, run, author, fetchFn);
        return c.json({ ok: true });
    };
