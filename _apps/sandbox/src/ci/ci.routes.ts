import { type AgentTurn, ciContract, type CiRepo, type PipelineRun } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { startConversationTurn } from "../agent/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// The owner-facing CI surface (the Pipelines rail view's whole backend). Reads serve the webhook-freshened
// cache and backfill it over the vendors' REST APIs when stale — a freshly opened view gets history even on a
// sandbox whose webhooks never registered. Actions re-resolve repo → project per call (a stale card must not
// act on a project the workspace no longer maps to) and translate vendor refusals into BAD_GATEWAY with the
// vendor's own words, the one boundary where the message is the whole point.

const RUNS_PER_PROJECT = 15;
// How much failed-job log tail seeds a fix conversation — enough to see the actual error, small enough that
// the turn's context stays about fixing rather than scrolling.
const FIX_LOG_BYTES = 24_000;
const TITLE_MAX = 80;

// The same uniqueness recipe as scheduler's mintConversationId, for a conversation a CLICK opens rather than
// an automation: bounded, charset-safe, unique per process.
let fixSeq = 0;
const mintFixConversationId = (runId: number, now: number): string => `ci-fix-${runId}-${now.toString(36)}${(fixSeq++).toString(36)}`;

// A vendor refusal (403 on rerun, an expired run) is an upstream answer, not a daemon bug: 502 carrying
// the vendor's message, so the view can show WHY instead of a blank 500.
const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        throw new ORPCError("BAD_GATEWAY", { message: error instanceof Error ? error.message : String(error) });
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
        runs: i.runs.handler(async () => {
            const projects = await ciProjects(services);
            const warnings = services.ciHooks.warnings();
            const repos: CiRepo[] = projects.map((project) => {
                const warning = warnings.get(project.repo);
                return {
                    repo: project.repo,
                    host: project.account.provider,
                    project: project.project,
                    url: ciClientFor(project.account.provider, fetchFn).projectUrl(project),
                    ...(warning !== undefined ? { hookWarning: warning } : {}),
                };
            });
            const seenAt = await services.ciStore.seenAt();
            const seen = seenAt === undefined ? {} : { seenAt };
            const cached = services.ciRuns.sweep();
            if (cached !== undefined) {
                return { repos, runs: cached, ...seen };
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
            return { repos, runs: services.ciRuns.replace(listed.flat()), ...seen };
        }),
        // The daemon's clock, not the browser's: a device with a fast clock would otherwise stamp itself past
        // failures that have not happened yet and silence them before they arrive.
        seen: i.seen.handler(async () => {
            const at = Date.now();
            await services.ciStore.markSeen(at);
            return { seenAt: at };
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
            const prompt = [
                `The CI pipeline for the workspace repo "${input.repo}" failed ${where}. Investigate and fix it.`,
                ...(failedJobs.length > 0 ? [`Failed jobs: ${failedJobs.join(", ")}.`] : []),
                `Reproduce the failure locally in the repo before changing anything, fix the cause, and verify the failing checks pass. You are in an isolated worktree: commit your fix and it goes through review.`,
                ...(logs !== "" ? [`--- failed job logs (tails) ---\n${logs}`] : []),
            ].join("\n\n");
            const conversationId = mintFixConversationId(input.runId, Date.now());
            const turn: AgentTurn & { conversationId: string } = {
                prompt,
                conversationId,
                isolated: true,
                // Nobody chose a model for this: it is one click on a red row. `agentRunModel` answers for it
                // (turn-resume.ts), which is also what the button's own tooltip names before the click.
                unattended: true,
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
                // Minted ids are unique, so this is an invariant breach rather than a user-level busy state.
                throw new ORPCError("CONFLICT", { message: "the CI fix conversation is already running" });
            }
            return { conversationId };
        }),
    };
};
