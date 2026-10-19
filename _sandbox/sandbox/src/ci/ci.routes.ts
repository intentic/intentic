import { errorMessage } from "@intentic/base/errors";
import { ciContract } from "@intentic/sandbox-contract/contracts/ci.contract";
import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { implement, ORPCError } from "@orpc/server";
import { areasOf } from "../auth/principal.js";
import { speakerOf, spokenBy } from "../seams/turn-speaker.js";
import { opt } from "../opt.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { AttemptRefused } from "../conversations/fix/fix-attempts.js";
import { ciFailureEvidence, runOf, startCiFix } from "./ci-fix.js";
import { fixPressed, mainFailures, streakFixerFor } from "./main-fixer.js";
import { createCiFailureLog } from "./logs/ci-failure-log.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";
import type { RunsCache } from "./runs-cache.js";

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

// One list call per project in flight, shared by every board that finds the picture stale while it runs, where each
// used to ask the vendor itself. Joined only while it began within the cache's TTL of the caller asking: its runs then
// land after the caller asked, read no earlier than the oldest sweep the TTL rule would have served it. Keyed by the
// account too, so a caller after a token change never joins a call made with the one before. Never rejects: a failing
// vendor drops just its own repos, not the whole view.
const sharedRunLists = (
    cache: () => Pick<RunsCache, "ttlMs">,
    fetchFn: FetchFn,
    backfill: ReturnType<typeof createCiFailureLog>,
): ((project: CiProject) => Promise<PipelineRun[]>) => {
    const listing = new Map<string, { readonly begun: number; readonly runs: Promise<PipelineRun[]> }>();
    return (project) => {
        const key = [project.account.apiBase, project.account.token, project.project, project.repo].join("\n");
        const held = listing.get(key);
        if (held !== undefined && Date.now() - held.begun <= cache().ttlMs) {
            return held.runs;
        }
        const flight = {
            begun: Date.now(),
            runs: ciClientFor(project.account.provider, fetchFn)
                .listRuns(project, RUNS_PER_PROJECT)
                .then(
                    (runs) => {
                        backfill.succeeded(project.repo);
                        return runs;
                    },
                    (error: unknown) => {
                        backfill.failed(project.repo, error);
                        return [];
                    },
                )
                .finally(() => {
                    if (listing.get(key) === flight) {
                        listing.delete(key);
                    }
                }),
        };
        listing.set(key, flight);
        return flight.runs;
    };
};

export const createCiRoutes = (services: Services, fetchFn: FetchFn = fetch) => {
    const i = implement(ciContract).$context<OrpcContext>();
    // Every open Pipelines board re-lists on a stale cache, so a dead token used to write this line on each read.
    const backfill = createCiFailureLog(services.logger, "ci: runs backfill failed", "ci: runs backfill works again");
    const listRuns = sharedRunLists(() => services.ciRuns, fetchFn, backfill);
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
            const failures = await mainFailures(services);
            const cached = services.ciRuns.sweep();
            if (cached !== undefined) {
                return { repos, runs: cached, failures };
            }
            const listed = await Promise.all(projects.map(listRuns));
            return { repos, runs: services.ciRuns.replace(listed.flat()), failures };
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
            // Together, since the press waits on both before any agent exists: the run is usually cached, but a cold
            // daemon lists the project's runs for it.
            const [evidence, run] = await Promise.all([
                ciFailureEvidence(project, input.runId, services.logger, fetchFn),
                runOf(services, project, input.runId, fetchFn),
            ]);
            // A run that died in its runner's own setup, or whose log names the fleet, never ran a line of this repository:
            // an agent opened on it would fix code that is fine, so it is refused with the reason unless forced.
            if (evidence.infra && input.force !== true) {
                const where = evidence.infraSteps.length > 0 ? ` (${evidence.infraSteps.join(", ")})` : "";
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: `Every failed job died on the fleet${where}, not in any step of this repository: bring the runner back and re-run the pipeline; force the fix to put an agent on it anyway.`,
                });
            }
            // A run of a failing main-line branch is its streak's: the press continues the one fix agent on it.
            const streak = run === undefined ? undefined : await streakFixerFor(services, run);
            const outcome = await startCiFix(
                services,
                {
                    project,
                    runId: input.runId,
                    run,
                    ...(streak === undefined ? {} : { base: streak }),
                    evidence,
                    // Never `unattended`: somebody pressed Fix and is watching the board it started from, so this is an
                    // ordinary session with a prepared prompt. The pick's fields ARE the turn's, spread verbatim.
                    turn: {
                        ...input.pick,
                        // Whoever pressed Fix, verified as POST /agent verifies it: the conversation is theirs.
                        ...spokenBy(speakerOf(context.identity, context.principal)),
                        ...opt("areas", areasOf(context.identity)),
                    },
                    picked: input.pick !== undefined,
                    ...opt("fallback", input.fallback),
                    pressed: true,
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
            if (run !== undefined && streak !== undefined) {
                await fixPressed(services, run, outcome.conversationId);
            }
            return { conversationId: outcome.conversationId };
        }),
    };
};
