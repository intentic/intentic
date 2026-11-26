import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type MainBaseline, mainBaselines, OUTCOMES_DIR } from "@intentic/output-cleaners/outcomes";
import { ciContract } from "@intentic/sandbox-contract/contracts/ci.contract";
import type { CiFailedStep, CiLocalMain, CiRepo, CiRunParam, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { implement, ORPCError } from "@orpc/server";
import { opt } from "../opt.js";
import { operatorHere } from "../auth/operator.js";
import { logsRoot } from "../seams/logs-root.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { callingExtensionIdentity } from "../extensions/runtime/calling-extension.js";
import { ciInputOf, createCiFailureLog } from "./logs/ci-failure-log.js";
import { localMainText } from "./local-main.js";
import { mainLinesOf } from "./main-line.js";
import { handOverRepair } from "./repair-hand-over.js";
import { type ForgeClient as CiClient, forgeClientFor as ciClientFor, type FailedStep } from "../forge/client.js";
import type { FetchFn } from "../forge/http.js";
import { ciProjects, type CiProject } from "./projects.js";
import { deploymentReportDeps, reportDeployment } from "../forge/forge-deployments.js";
import { noteAudit } from "../audit/audit-http.js";
import type { RunsCache } from "./runs-cache.js";

// CI ingestion's routes: what the forges report, read from the webhook-freshened cache and backfilled from the vendor's
// REST API when stale, the vendor's actions passed along, and (2026-11-26) the forge reads the pipelines extension's
// backend asks for main's fix agent and the Pipelines board, through the core's clients and credentials. Each
// re-resolves repo -> project per call, since a stale card must not act on a project the workspace no longer maps to; a
// vendor refusal becomes BAD_GATEWAY carrying its own message. Main's fix agent and the board's own procedures (main's
// failures, forget, fix, what main is known to fail on) are that backend's since 2026-11-26.

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
        // A repo whose last lists failed waits out its backoff, and one refused for its token or mapping waits for either
        // to change, rather than asking the forge again on every board read.
        const input = ciInputOf(project);
        if (!backfill.due(project.repo, input)) {
            return Promise.resolve([]);
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
                        backfill.failed(project.repo, error, input);
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

// A failed job as the wire carries it, its lists its own.
const wireStep = (step: FailedStep): CiFailedStep => ({
    job: step.job,
    id: step.id,
    ...opt("step", step.step),
    ...opt("steps", step.steps === undefined ? undefined : [...step.steps]),
    ...opt("reason", step.reason),
    ...opt("annotations", step.annotations === undefined ? undefined : [...step.annotations]),
    ...opt("runner", step.runner),
});

// A recorded baseline as the contract carries it.
const localOf = (baseline: MainBaseline): CiLocalMain => ({
    repo: baseline.repo,
    sha: baseline.sha,
    at: baseline.at,
    runs: baseline.runs.map((run) => ({ command: run.command, at: run.at, ...opt("by", run.by), failed: run.counts.failed, passed: run.counts.passed })),
    failed: baseline.failed.map((failure) => ({ test: failure.test, ...opt("line", failure.line), at: failure.at })),
});

const resolveProject = async (services: Services, repo: string): Promise<CiProject> => {
    const project = (await ciProjects(services)).find((candidate) => candidate.repo === repo);
    if (project === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no CI project mapped for repo "${repo}"` });
    }
    return project;
};

export const createCiRoutes = (services: Services, fetchFn: FetchFn = fetch) => {
    const i = implement(ciContract).$context<OrpcContext>();
    // Every open Pipelines board re-lists on a stale cache, so a dead token used to write this line on each read.
    const backfill = createCiFailureLog(services.logger, "ci: runs backfill failed", "ci: runs backfill works again");
    const listRuns = sharedRunLists(() => services.ciRuns, fetchFn, backfill);
    const resolve = (repo: string): Promise<CiProject> => resolveProject(services, repo);
    // One call to a repository's forge, through its client, a refusal as the forge said it.
    const onProject = async <T>(repo: string, call: (client: CiClient, project: CiProject) => Promise<T>): Promise<T> => {
        const project = await resolve(repo);
        return upstream(call(ciClientFor(project.account.provider, fetchFn), project));
    };
    // A press on a run the daemon only passes along to its forge.
    const onRun =
        (verb: "rerun" | "cancel" | "dispatch" | "rerunFailed") =>
        async ({ input }: { readonly input: CiRunParam }) => {
            await onProject(input.repo, (client, project) => client[verb](project, input.runId));
            return { ok: true as const };
        };
    // The extension a request comes from, by its own token: the claim and the hand-over are an extension's alone.
    const callingExtension = async (context: OrpcContext): Promise<string> => {
        const identity = await callingExtensionIdentity(services, (name) => context.headers.get(name));
        if (identity === undefined) {
            throw new ORPCError("FORBIDDEN", { message: "only an extension's own token asks this" });
        }
        return identity;
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
            const listed = await Promise.all(projects.map(listRuns));
            return { repos, runs: services.ciRuns.replace(listed.flat()) };
        }),
        // (2026-11-25) A deployment told to the repository's forge, for the Deployments extension (forge/forge-deployments.ts).
        reportDeployment: i.reportDeployment.handler(async ({ input }) => {
            noteAudit({ target: `${input.repo}:${input.environment}` });
            return await reportDeployment(deploymentReportDeps(() => ciProjects(services), fetchFn), input);
        }),
        rerun: i.rerun.handler(onRun("rerun")),
        cancel: i.cancel.handler(onRun("cancel")),
        dispatch: i.dispatch.handler(onRun("dispatch")),
        rerunFailed: i.rerunFailed.handler(onRun("rerunFailed")),
        jobs: i.jobs.handler(async ({ input }) => ({ jobs: await onProject(input.repo, (client, project) => client.allJobs(project, input.runId)) })),
        list: i.list.handler(async ({ input }) => ({ runs: await onProject(input.repo, (client, project) => client.listRuns(project, input.limit)) })),
        run: i.run.handler(async ({ input }) => ({ run: await onProject(input.repo, (client, project) => client.run(project, input.runId)) })),
        failedSteps: i.failedSteps.handler(async ({ input }) => {
            const steps = await onProject(input.repo, (client, project) => client.failedSteps(project, input.runId));
            return { steps: steps.map(wireStep) };
        }),
        passedJobs: i.passedJobs.handler(async ({ input }) => ({ jobs: await onProject(input.repo, (client, project) => client.passedJobs(project, input.runId)) })),
        workflow: i.workflow.handler(async ({ input }) => {
            const source = await onProject(input.repo, (client, project) => client.workflowSource(project, input.runId));
            return { ...opt("root", source?.root), called: Object.fromEntries(source?.called ?? []) };
        }),
        // Whole: a failed job's errors can sit anywhere in it, and only the reader's digest of it reaches an agent.
        jobLog: i.jobLog.handler(async ({ input }) => ({
            log: await onProject(input.repo, (client, project) => client.jobLog(project, input.jobId, Number.POSITIVE_INFINITY)),
        })),
        jobAnnotations: i.jobAnnotations.handler(async ({ input }) => ({
            annotations: [...(await onProject(input.repo, (client, project) => client.annotations(project, input.jobId)))],
        })),
        mainLines: i.mainLines.handler(async () => ({
            lines: await Promise.all(
                (await ciProjects(services)).map(async (project) => {
                    const line = await mainLinesOf(services, project);
                    const concluded = await Promise.all(
                        line.branches.map(async (branch) => {
                            const heard = await services.ciStore.conclusion(project.repo, branch);
                            return heard === undefined ? [] : [{ branch, ...heard }];
                        }),
                    );
                    return { repo: project.repo, host: project.account.provider, project: project.project, ...line, concluded: concluded.flat() };
                }),
            ),
        })),
        claimMainLines: i.claimMainLines.handler(async ({ input, context }) => {
            await services.ciStore.claimMainLines(await callingExtension(context), input.claimed, Date.now());
            services.logger.info({ claimed: input.claimed }, "ci: an extension's claim on main lines' failures changed");
            return { ok: true as const };
        }),
        handOverRepair: i.handOverRepair.handler(async ({ context }) => handOverRepair(services, await callingExtension(context))),
        localMain: i.localMain.handler(() => {
            const local = mainBaselines(join(logsRoot(services.config.historyRoot), OUTCOMES_DIR)).map(localOf);
            return { local, text: localMainText(local, Date.now()) };
        }),
    };
};
