import { createHmac } from "node:crypto";
import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { WakeFn } from "../automations/scheduler.js";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { dispatchCiRun } from "./events.js";
import { ciClientFor, type FetchFn, type GithubRun, githubRun, type GitlabPipelineHook, gitlabHookRun, gitlabStatus } from "./providers.js";
import { ciProjects } from "./projects.js";

// Public webhook receiver, gated by the per-sandbox secret (github HMACs the body, gitlab echoes it as a token); one
// route for both vendors. An unmapped project's delivery is acknowledged and dropped, not an error. Verifies the sender
// and normalizes into a PipelineRun; what a finished run means is ci/events.ts, shared with the poller.

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

        // projectPath plus a run normalizer; undefined for a ping, an in-progress phase, or an unconsumed event.
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
                // Fires at every phase; gates on "not in flight", not "not running" since queued is neither.
                !isPipelineInFlight(gitlabStatus(delivery.object_attributes.status))
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
        await dispatchCiRun(services, run, author, wake);
        return c.json({ ok: true });
    };
