import { errorMessage } from "@intentic/base/errors";
import { type AgentTurn, ciContract, ciFixConversationId, type CiRepo, type PipelineRun } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { startConversationTurn } from "../agent/run/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// The owner-facing CI surface (the Pipelines rail view's whole backend). Reads serve the webhook-freshened
// cache and backfill it over the vendors' REST APIs when stale, a freshly opened view gets history even on a
// sandbox whose webhooks never registered. Actions re-resolve repo → project per call (a stale card must not
// act on a project the workspace no longer maps to) and translate vendor refusals into BAD_GATEWAY with the
// vendor's own words, the one boundary where the message is the whole point.

const RUNS_PER_PROJECT = 15;
// How much failed-job log tail seeds a fix conversation, enough to see the actual error, small enough that
// the turn's context stays about fixing rather than scrolling.
const FIX_LOG_BYTES = 24_000;
const TITLE_MAX = 80;

// A vendor refusal (403 on rerun, an expired run) is an upstream answer, not a daemon bug: 502 carrying
// the vendor's message, so the view can show WHY instead of a blank 500.
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
            // The recipe carries the webhook SECRET, so it reaches an operator's screen and nobody else's: not a
            // viewer reading the board, not a program holding a read token (auth/operator.ts).
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
            // Backfill sweep: one list call per project, a failing vendor degrades to its repos missing rather
            // than the whole view erroring (the other host's runs are still worth showing).
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
            // The run's metadata for the prompt: the cache usually has it (the view the click came from was
            // just looking at it); a cold daemon re-lists.
            const run: PipelineRun | undefined =
                (services.ciRuns.sweep() ?? []).find((candidate) => candidate.repo === input.repo && candidate.runId === input.runId) ??
                (await client.listRuns(project, RUNS_PER_PROJECT).catch(() => [])).find((candidate) => candidate.runId === input.runId);
            const [failedJobs, logs] = await Promise.all([
                client.failedJobs(project, input.runId).catch(() => []),
                client.failedJobLogs(project, input.runId, FIX_LOG_BYTES).catch(() => ""),
            ]);
            const where = run !== undefined ? `on branch ${run.branch} (${run.url})` : `(run ${input.runId})`;
            /* THE INSTRUCTION KNOWS WHERE IT IS RUNNING, which the first version of it did not. It said
             * "reproduce the failure locally before changing anything", and for about half the jobs in this
             * repository's pipelines that is an instruction to do something impossible: the nightly's jobs
             * want docker-in-docker and a mounted socket, the desktop ones want a runner with webkit and a
             * Windows box, the image ones want to build a CI image from scratch. Agents obeyed it anyway,
             * because it was the instruction — $27 and $33 turns spent building images and guessing, and one
             * of them needed a second round because the fix could not be tested from here either way.
             *
             * So it names the boundary and names the way ACROSS it. A job the local suite covers is reproduced;
             * a job it does not is read, changed, and verified by dispatching the workflow on the agent's own
             * branch — which is the only place the runner constraints actually exist. Stated as a rule about
             * environments rather than as a list of job names, because a list here would be a second copy of
             * .github/workflows/ that nothing updates when a job moves. */
            const prompt = [
                `The CI pipeline for the workspace repo "${input.repo}" failed ${where}. Investigate and fix it.`,
                ...(failedJobs.length > 0 ? [`Failed jobs: ${failedJobs.join(", ")}.`] : []),
                `The logs below are the evidence — read them first; they are usually enough to name the cause.`,
                `REPRODUCE LOCALLY ONLY IF THIS SANDBOX CAN. \`pnpm verify:push\` runs the checkout gates, typecheck, build and tests, which is what the preflight and verify-* jobs run, so those reproduce here exactly. Jobs that need Docker, a fresh CI image, a desktop runner, a GPU, Windows or Xcode DO NOT: this sandbox has none of them, and an hour spent standing one up is an hour that ends in a guess anyway.`,
                `For a job you cannot run here: make the change from the logs, then verify it in the place the constraints exist by dispatching the workflow on your own branch (\`gh workflow run <workflow.yml> --ref <your branch>\`, then \`gh run watch\`). Say plainly in your summary if you could not verify it and what would.`,
                `You are in an isolated worktree: commit your fix and it goes through review.`,
                ...(logs !== "" ? [`--- failed job logs (tails) ---\n${logs}`] : []),
            ].join("\n\n");
            /* DERIVED FROM THE RUN, never minted: this is the name the Pipelines board re-computes to find out
             * whether an agent is already on this failure (conversation-ids.ts has the whole argument). One
             * failed run is therefore one conversation, one worktree and one branch, however many times the
             * button is pressed. */
            const conversationId = ciFixConversationId(input.repo, input.runId);
            const turn: AgentTurn & { conversationId: string } = {
                prompt,
                conversationId,
                isolated: true,
                /* Started by a surface rather than by someone at a composer, so the `pipeline-fix` list answers for it
                 * (turn-resume.ts), which is also what the button's own caret names before the click.
                 *
                 * UNLESS they used that caret. A pick rides on as the turn's own agent/model/effort, and the
                 * daemon's fill step then leaves it alone because it only fills what is absent. The flag stays
                 * either way: it is what the turn IS, not a statement about whether a model was named. */
                unattended: true,
                runRole: `pipeline-fix`,
                ...(input.pick !== undefined
                    ? { agent: input.pick.agent, model: input.pick.model, ...(input.pick.effort === undefined ? {} : { effort: input.pick.effort }) }
                    : {}),
                title: `Fix CI: ${run?.title ?? input.repo}`.slice(0, TITLE_MAX),
            };
            /* Use the SAME detached-run boundary as POST /agent. The old fire-and-forget generator bypassed the
             * run map, turn journal, transcript record, and push observer. The UI navigated to the returned id,
             * found no attachable run and no persisted transcript, and quite correctly opened an empty chat
             * while the work happened invisibly. This call returns synchronously with the run registered; its
             * provider work still outlives the request. It is also what gives the fix its ordinary fleet card:
             * `conversationId` is what streamAgent registers on, whatever placement the turn asked for. */
            const started = await startConversationTurn(services, wake, turn);
            if (started === undefined) {
                /* A REAL STATE NOW, not an invariant breach: the id is derived, so a second press on the same
                 * failure addresses the conversation the first one opened. Live, that turn is the answer and
                 * this says so in words the board can show; finished, the call above adds a turn to it instead,
                 * which is what makes "try again" continue the fix rather than start a rival agent. */
                throw new ORPCError("CONFLICT", { message: "An agent is already working on this run's failure." });
            }
            return { conversationId };
        }),
    };
};
