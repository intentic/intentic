import { createHmac } from "node:crypto";
import type { PipelineRun } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/agent.routes.js";
import { dispatchListenerMessage, type ListenerMessage } from "../automations/listeners.js";
import type { WakeFn } from "../automations/scheduler.js";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { ciClientFor, type FetchFn, type GithubRun, githubRun, type GitlabPipelineHook, gitlabHookRun, gitlabStatus } from "./providers.js";
import { ciProjects } from "./projects.js";

/* The public webhook receiver — the CI counterpart of /automations/{id}/fire (senders can't do Google ID
 * tokens), reached unauthenticated via app.ts's ciWebhookPath exception and gated by the per-sandbox secret
 * the reconciler registered: github signs the raw body with it (X-Hub-Signature-256), gitlab echoes it
 * verbatim (X-Gitlab-Token). One route serves both vendors; the payload names the project and the workspace
 * mapping (projects.ts) names the repo — a delivery for a project the workspace no longer maps to is
 * acknowledged and dropped, not an error, because the provider retries errors and there is nothing to retry.
 *
 * A terminal run freshens the runs cache and — for the two results that ARE results — dispatches `ci`
 * listener messages: `pipeline_failed` or `pipeline_succeeded`, plus `pipeline_fixed` riding along when a
 * success ends a recorded failure streak on that repo+branch (the batcher folds the pair into one wake for an
 * automation listening to everything). Canceled/skipped runs freshen the cache only: they are outcomes, not
 * results. */

// `ci` — the core listener provider automations name (the webchat precedent: no gateway extension declares
// it). One provider for both vendors: a trigger narrows by repo and result, not by who hosts the pipeline.
export const CI_PROVIDER = "ci";
export const CI_EVENT_TYPES = new Set(["pipeline_failed", "pipeline_succeeded", "pipeline_fixed"]);

const sha7 = (sha: string): string => sha.slice(0, 7);

const contentOf = (run: PipelineRun, type: string): string => {
    const what = type === "pipeline_fixed" ? "CI fixed (back to green)" : run.status === "failed" ? "CI failed" : "CI passed";
    const jobs = run.failedJobs !== undefined && run.failedJobs.length > 0 ? ` — failed jobs: ${run.failedJobs.join(", ")}` : "";
    return `${what}: ${run.repo} ${run.branch} @ ${sha7(run.sha)}${jobs} — ${run.url}`;
};

const messageOf = (run: PipelineRun, type: string, author: { id: string; name: string }): ListenerMessage => ({
    provider: CI_PROVIDER,
    type,
    id: `${run.host}:${run.project}:${run.runId}:${type}`,
    channelId: run.repo,
    author,
    content: contentOf(run, type),
    timestamp: new Date().toISOString(),
    extra: {
        host: run.host,
        repo: run.repo,
        project: run.project,
        runId: run.runId,
        branch: run.branch,
        sha: run.sha,
        status: run.status,
        url: run.url,
        ...(run.failedJobs !== undefined ? { failedJobs: run.failedJobs } : {}),
        ...(run.durationSeconds !== undefined ? { durationSeconds: run.durationSeconds } : {}),
    },
});

interface GithubDelivery {
    readonly action?: string;
    readonly workflow_run?: GithubRun & { readonly actor?: { readonly login?: string } };
    readonly repository?: { readonly full_name?: string };
}

export const createCiWebhookRoute =
    (services: Services, wake: WakeFn = streamAgent, fetchFn: FetchFn = fetch) =>
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

        // Which project the delivery speaks for + the vendor's run object, or nothing interesting: a ping, a
        // requested/in_progress phase, an event kind the hook subscribes to that we don't consume.
        let projectPath: string | undefined;
        let author = { id: host, name: host };
        let toRun: ((project: { repo: string; project: string }) => PipelineRun) | undefined;
        if (host === "github") {
            const delivery = payload as GithubDelivery;
            if (c.req.header("x-github-event") === "workflow_run" && delivery.action === "completed" && delivery.workflow_run !== undefined) {
                const run = delivery.workflow_run;
                projectPath = delivery.repository?.full_name;
                author = run.actor?.login !== undefined ? { id: run.actor.login, name: run.actor.login } : author;
                toRun = (project) => githubRun(project, run);
            }
        } else {
            const delivery = payload as Partial<GitlabPipelineHook>;
            if (
                c.req.header("x-gitlab-event") === "Pipeline Hook" &&
                delivery.object_attributes !== undefined &&
                delivery.project !== undefined &&
                gitlabStatus(delivery.object_attributes.status) !== "running"
            ) {
                projectPath = delivery.project.path_with_namespace;
                const user = delivery.user;
                author =
                    user?.name !== undefined || user?.username !== undefined
                        ? { id: user.username ?? user.name ?? host, name: user.name ?? user.username ?? host }
                        : author;
                toRun = (project) => gitlabHookRun(project, delivery as GitlabPipelineHook);
            }
        }
        if (projectPath === undefined || toRun === undefined) {
            return c.json({ ok: true, ignored: true });
        }

        const wanted = projectPath.toLowerCase();
        const project = (await ciProjects(services)).find(
            (candidate) => candidate.account.provider === host && candidate.project.toLowerCase() === wanted,
        );
        if (project === undefined) {
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

        if (run.status === "failed" || run.status === "success") {
            const previous = await services.ciStore.lastConclusion(run.repo, run.branch);
            await services.ciStore.recordConclusion(run.repo, run.branch, run.status === "failed" ? "failed" : "success", Date.now());
            const types =
                run.status === "failed" ? ["pipeline_failed"] : ["pipeline_succeeded", ...(previous === "failed" ? ["pipeline_fixed"] : [])];
            for (const type of types) {
                await dispatchListenerMessage(services, messageOf(run, type, author), wake);
            }
        }
        return c.json({ ok: true });
    };
