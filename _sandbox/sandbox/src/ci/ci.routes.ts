import { errorMessage } from "@intentic/base/errors";
import { ciContract, type CiRepo } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { actorOf, areasOf, ownerOf } from "../auth/principal.js";
import { opt } from "../opt.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { AttemptRefused, ciFailureEvidence, startCiFix } from "./ci-fix.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// Backend for the Pipelines rail: reads serve the webhook-freshened cache, backfilled from the vendor's REST API when
// stale. Actions re-resolve repo -> project per call, since a stale card must not act on a project the workspace no
// longer maps to; a vendor refusal becomes BAD_GATEWAY carrying its own message.

const RUNS_PER_PROJECT = 15;

// A vendor refusal is an upstream answer, not a daemon bug: rethrown as 502 carrying the vendor's own message.
const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
    }
};

export const createCiRoutes = (services: Services, fetchFn: FetchFn = fetch) => {
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
        fix: i.fix.handler(async ({ input, context }) => {
            const project = await resolve(input.repo);
            const evidence = await ciFailureEvidence(project, input.runId, services.logger, fetchFn);
            // A run that died in its runner's own setup, or whose log names the fleet, never ran a line of this repository:
            // an agent opened on it would fix code that is fine, so it is refused with the reason unless forced.
            if (evidence.infra && input.force !== true) {
                const where = evidence.infraSteps.length > 0 ? ` (${evidence.infraSteps.join(", ")})` : "";
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: `Every failed job died on the fleet${where}, not in any step of this repository: bring the runner back and re-run the pipeline; force the fix to put an agent on it anyway.`,
                });
            }
            const outcome = await startCiFix(
                services,
                {
                    project,
                    runId: input.runId,
                    evidence,
                    // Never `unattended`: somebody pressed Fix and is watching the board it started from, so this is an
                    // ordinary session with a prepared prompt. The pick's fields ARE the turn's, spread verbatim.
                    turn: {
                        ...input.pick,
                        // Whoever pressed Fix, verified as POST /agent verifies it: the conversation is theirs.
                        ...opt("actor", actorOf(context.identity, context.principal)),
                        ...opt("owner", ownerOf(context.identity)),
                        ...opt("areas", areasOf(context.identity)),
                    },
                    picked: input.pick !== undefined,
                    resume: input.mode,
                },
                fetchFn,
            ).catch((error: unknown) => {
                throw error instanceof AttemptRefused ? new ORPCError("CONFLICT", { message: error.message }) : error;
            });
            if (outcome.kind === "busy") {
                // In words, not as a bug: the reader is sent to the attempt in play rather than handed a second one.
                throw new ORPCError("CONFLICT", { message: outcome.reason });
            }
            return { conversationId: outcome.conversationId };
        }),
    };
};
