import { errorMessage } from "@intentic/base/errors";
import { type AgentTurn, ciContract, ciFixConversationId, type CiRepo, type PipelineRun } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { startConversationTurn } from "../agent/run/turn/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// Backend for the Pipelines rail: reads serve the webhook-freshened cache, backfilled from the vendor's REST API when
// stale. Actions re-resolve repo -> project per call, since a stale card must not act on a project the workspace no
// longer maps to; a vendor refusal becomes BAD_GATEWAY carrying its own message.

const RUNS_PER_PROJECT = 15;
// Failed-job log tail seeded into a fix conversation: enough to see the error, not to flood the context.
const FIX_LOG_BYTES = 24_000;
const TITLE_MAX = 80;

// A vendor refusal is an upstream answer, not a daemon bug: rethrown as 502 carrying the vendor's own message.
const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
    }
};

export const createCiRoutes = (services: Services, wake: WakeFn = streamAgent, fetchFn: FetchFn = fetch) => {
    const i = implement(ciContract).$context<OrpcContext>();
    const resolve = async (repo: string): Promise<CiProject> => {
        const project = (await ciProjects(services)).find((candidate) => candidate.repo === repo);
        if (project === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no CI project mapped for repo "${repo}"` });
        }
        return project;
    };
    return {
        runs: i.runs.handler(async ({ context }) => {
            const projects = await ciProjects(services);
            const warnings = services.ciHooks.warnings();
            // Carries the webhook secret; only an operator's screen gets it, not a viewer or a read-token program.
            const operator = operatorHere(services, context);
            const repos: CiRepo[] = projects.map((project) => {
                const warning = warnings.get(project.repo);
                return {
                    repo: project.repo,
                    host: project.account.provider,
                    project: project.project,
                    url: ciClientFor(project.account.provider, fetchFn).projectUrl(project),
                    ...(warning !== undefined ? { hookWarning: warning.reason } : {}),
                    ...(operator && warning?.recipe !== undefined ? { hookRecipe: warning.recipe } : {}),
                };
            });
            const cached = services.ciRuns.sweep();
            if (cached !== undefined) {
                return { repos, runs: cached };
            }
            // One list call per project; a failing vendor drops just its own repos, not the whole view.
            const listed = await Promise.all(
                projects.map((project) =>
                    ciClientFor(project.account.provider, fetchFn)
                        .listRuns(project, RUNS_PER_PROJECT)
                        .catch((error: unknown) => {
                            services.logger.warn({ err: error, repo: project.repo }, "ci: runs backfill failed");
                            return [];
                        }),
                ),
            );
            return { repos, runs: services.ciRuns.replace(listed.flat()) };
        }),
        rerun: i.rerun.handler(async ({ input }) => {
            const project = await resolve(input.repo);
            await upstream(ciClientFor(project.account.provider, fetchFn).rerun(project, input.runId));
            return { ok: true as const };
        }),
        cancel: i.cancel.handler(async ({ input }) => {
            const project = await resolve(input.repo);
            await upstream(ciClientFor(project.account.provider, fetchFn).cancel(project, input.runId));
            return { ok: true as const };
        }),
        jobs: i.jobs.handler(async ({ input }) => {
            const project = await resolve(input.repo);
            const jobs = await upstream(ciClientFor(project.account.provider, fetchFn).allJobs(project, input.runId));
            return { jobs };
        }),
        fix: i.fix.handler(async ({ input }) => {
            const project = await resolve(input.repo);
            const client = ciClientFor(project.account.provider, fetchFn);
            // Usually already in the cache, from the view the click came from; a cold daemon re-lists instead.
            const run: PipelineRun | undefined =
                (services.ciRuns.sweep() ?? []).find((candidate) => candidate.repo === input.repo && candidate.runId === input.runId) ??
                (await client.listRuns(project, RUNS_PER_PROJECT).catch(() => [])).find((candidate) => candidate.runId === input.runId);
            const [failedJobs, logs] = await Promise.all([
                client.failedJobs(project, input.runId).catch(() => []),
                client.failedJobLogs(project, input.runId, FIX_LOG_BYTES).catch(() => ""),
            ]);
            const where = run !== undefined ? `on branch ${run.branch} (${run.url})` : `(run ${input.runId})`;
            // Names the environment boundary, not job names, so the prompt can't drift from .github/workflows/.
            const prompt = [
                `The CI pipeline for the workspace repo "${input.repo}" failed ${where}. Investigate and fix it.`,
                ...(failedJobs.length > 0 ? [`Failed jobs: ${failedJobs.join(", ")}.`] : []),
                `The logs below are the evidence — read them first; they are usually enough to name the cause.`,
                `REPRODUCE LOCALLY ONLY IF THIS SANDBOX CAN. \`pnpm verify:push\` runs the checkout gates, typecheck, build and tests, which is what the preflight and verify-* jobs run, so those reproduce here exactly. Jobs that need Docker, a fresh CI image, a desktop runner, a GPU, Windows or Xcode DO NOT: this sandbox has none of them, and an hour spent standing one up is an hour that ends in a guess anyway.`,
                `For a job you cannot run here: make the change from the logs, then verify it in the place the constraints exist by dispatching the workflow on your own branch (\`gh workflow run <workflow.yml> --ref <your branch>\`, then \`gh run watch\`). Say plainly in your summary if you could not verify it and what would.`,
                `You are in an isolated worktree: commit your fix and it goes through review.`,
                ...(logs !== "" ? [`--- failed job logs (tails) ---\n${logs}`] : []),
            ].join("\n\n");
            // Derived from the run, not minted, so the board can tell an agent is on this failure via the same id.
            const conversationId = ciFixConversationId(input.repo, input.runId);
            const turn: AgentTurn & { conversationId: string } = {
                prompt,
                conversationId,
                isolated: true,
                // True regardless of a caret pick: it names the turn's origin, not whether a model was chosen.
                unattended: true,
                runRole: `pipeline-fix`,
                // Spread verbatim: AgentRunPick's fields ARE the turn's (agent, model, account, harness, effort,
                // thinking, fast), so there is nothing to translate and nothing that can be forgotten here.
                ...input.pick,
                title: `Fix CI: ${run?.title ?? input.repo}`.slice(0, TITLE_MAX),
            };
            // Same detached-run boundary as POST /agent, so the run map, journal, transcript and observer stay wired.
            const started = await startConversationTurn(services, wake, turn);
            if (started === undefined) {
                // undefined means the conversation already has a live turn; report that in words, not as a bug.
                throw new ORPCError("CONFLICT", { message: "An agent is already working on this run's failure." });
            }
            return { conversationId };
        }),
    };
};
