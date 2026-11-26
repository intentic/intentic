import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller } from "@intentic/extension-api";
import {
    type CiFixParam,
    CiFixParamSchema,
    type CiFixResponse,
    CiForgetParamSchema,
    type CiJobsResponse,
    CiRunParamSchema,
    type CiRunsResponse,
    type PipelineJob,
} from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";
import { FIX_ROUTE, FORGET_ROUTE, JOBS_ROUTE, RUNS_ROUTE } from "../backendRoutes.js";
import { ciFailureEvidence, jointEvidence, runOf, startCiFix, type WorkflowEvidence } from "./ci-fix.js";
import { AttemptRefused } from "./fix-attempts.js";
import { fixPressed, forgetFailure, mainFailures, streakFixerFor, streakRunsBeside } from "./main-fixer.js";
import { workflowOf } from "./main-streak.js";
import { opt } from "./opt.js";
import { ownerSteps } from "./owner-steps.js";
import { projectOf, type Repair } from "./repair.js";
import { resolveRun, type RunJob } from "./workflow-graph.js";

/* THE PIPELINES BOARD'S BACKEND (2026-11-26): what the board reads and presses that is this extension's own, the daemon's
   ci/ci.routes.ts until then. The runs come from the core's picture of what the forges report (GET /ci/runs), with main's
   failures and the steps fix agents ended on, which are this extension's; a run's jobs from the core's client with their
   graph drawn here from the run's workflow file; a failure set aside; and Fix, which starts the turn as whoever pressed
   (`api.caller`, handed back to POST /agent). A refusal the daemon answered comes back with its status and words. */

type Answer = CiRunsResponse | CiJobsResponse | CiFixResponse | { readonly ok: true } | { readonly error: string };

const json = (status: number, body: Answer): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A refusal the daemon answered carries its HTTP status, which the board's own answer keeps.
const AnsweredSchema = z.object({ status: z.number() });
const statusOf = (refusal: z.ZodSafeParseResult<{ readonly status: number }>): number => refusal.data?.status ?? 502;

// One job of the drawn graph: a reported job with its declared wiring, or a job only the workflow declares, which links
// to the job its call was reported as when there is one.
const graphJob = (job: RunJob, reported: readonly PipelineJob[]): PipelineJob => {
    const own = job.reported === undefined ? undefined : reported[job.reported];
    const standIn = job.standIn === undefined ? undefined : reported[job.standIn];
    const base: PipelineJob = own ?? { name: job.name, status: job.status, ...opt("webUrl", standIn?.webUrl) };
    return {
        ...base,
        ...opt("needs", job.needs === undefined ? undefined : [...job.needs]),
        ...opt("declaredId", job.declaredId),
        ...opt("matrix", job.matrix),
    };
};

/** A run's jobs as GitHub draws them: every declared job, the ones not reported yet (or never) included, in its order,
 *  wired by `needs`, when its workflow file can be read; else as the forge reports them. */
export const jobsOf = async (repair: Pick<Repair, "daemon">, repo: string, runId: number): Promise<PipelineJob[]> => {
    const [reported, workflow] = await Promise.all([repair.daemon.allJobs(repo, runId), repair.daemon.workflow(repo, runId)]);
    const graph = workflow.root === undefined ? undefined : resolveRun(workflow.root, reported, new Map(Object.entries(workflow.called)));
    return graph === undefined ? [...reported] : graph.map((job) => graphJob(job, reported));
};

// What a Fix press hands its agent: the pressed run's failed jobs and, when the run is one of a failing main's, every other
// failing workflow's newest failed run too, as the banner it was pressed from names them, so the agent fixes the branch
// rather than one workflow of it. `handed` is each job the prompt carried, by its own run, for the press to acknowledge.
const pressEvidence = async (repair: Repair, project: Parameters<typeof ciFailureEvidence>[1], runId: number) => {
    const [pressed, run] = await Promise.all([ciFailureEvidence(repair, project, runId), runOf(repair, project, runId)]);
    const beside = run === undefined ? [] : await streakRunsBeside(repair, run);
    const parts: WorkflowEvidence[] = [
        { workflow: workflowOf(run?.workflow), runId, url: run?.url, evidence: pressed },
        ...(await Promise.all(
            beside.map(async (other) => ({
                ...other,
                url: (await runOf(repair, project, other.runId))?.url,
                evidence: await ciFailureEvidence(repair, project, other.runId),
            })),
        )),
    ];
    return {
        run,
        evidence: jointEvidence(parts),
        handed: parts.flatMap((part) => part.evidence.failedJobIds.map((jobId) => ({ runId: part.runId, jobId }))),
    };
};

/** A press of Fix on a failed run, as whoever pressed. */
export const fix = async (repair: Repair, input: CiFixParam, caller: ExtensionCaller): Promise<Response> => {
    const project = await projectOf(repair, input.repo);
    if (project === undefined) {
        return json(404, { error: `no CI project mapped for repo "${input.repo}"` });
    }
    const { run, evidence, handed } = await pressEvidence(repair, project, input.runId);
    // A run that died in its runner's own setup, or whose log names the fleet, never ran a line of this repository: an
    // agent opened on it would fix code that is fine, so it is refused with the reason unless forced.
    if (evidence.infra && input.force !== true) {
        return json(412, {
            error: `Not a code failure: ${evidence.infraReasons.join("; ")}. Bring the runner back and re-run the failed jobs, or force the fix to put an agent on it anyway.`,
        });
    }
    // A run of a failing main-line branch is its streak's: the press continues the one fix agent on it.
    const streak = run === undefined ? undefined : await streakFixerFor(repair, run);
    const start = () =>
        startCiFix(repair, {
            project,
            runId: input.runId,
            run,
            ...opt("base", streak),
            evidence,
            // Never `unattended`: somebody pressed Fix and is watching the board it started from. The pick's fields ARE the
            // turn's, spread verbatim; a model with no allowance left was chosen for later, booked as a composer's send is.
            turn: { ...input.pick, ...opt("sendAt", input.sendAt), ...opt("sendAtReopen", input.sendAtReopen) },
            pressedBy: caller,
            resume: input.mode,
        });
    try {
        const outcome = run !== undefined && streak !== undefined ? await fixPressed(repair, run, handed, start) : await start();
        // In words, not as a bug: the reader is sent to the attempt in play rather than handed a second one.
        return outcome.kind === "busy" ? json(409, { error: outcome.reason }) : json(200, { conversationId: outcome.conversationId });
    } catch (error) {
        return error instanceof AttemptRefused ? json(409, { error: error.message }) : json(statusOf(AnsweredSchema.safeParse(error)), { error: errorMessage(error) });
    }
};

// A request's JSON body read by `schema`, or the answer refusing it.
const bodyOf = async <S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S> | Response> => {
    // allow(silent-catch): a body that is not JSON is no request, which the schema below refuses
    const parsed = schema.safeParse(await request.json().catch(() => undefined));
    return parsed.success ? parsed.data : json(400, { error: parsed.error.issues[0]?.message ?? "the body does not parse" });
};

/** The board's routes under this extension's namespace; undefined for a request that is none of them. */
export const boardRoute = async (repair: Repair, request: Request, caller: ExtensionCaller | undefined): Promise<Response | undefined> => {
    const route = new URL(request.url).pathname.replace(/^\/+/u, "");
    try {
        if (request.method === "GET" && route === RUNS_ROUTE) {
            const [runs, failures, steps] = await Promise.all([repair.daemon.runs(), mainFailures(repair), ownerSteps(repair)]);
            return json(200, { ...runs, failures, ownerSteps: steps });
        }
        if (request.method !== "POST") {
            return undefined;
        }
        if (route === JOBS_ROUTE) {
            const input = await bodyOf(request, CiRunParamSchema);
            return input instanceof Response ? input : json(200, { jobs: await jobsOf(repair, input.repo, input.runId) });
        }
        if (route === FORGET_ROUTE) {
            const input = await bodyOf(request, CiForgetParamSchema);
            if (input instanceof Response) {
                return input;
            }
            // Nothing left to take off is no failure of the press: a second click, or a board a moment behind.
            await forgetFailure(repair, input);
            return json(200, { ok: true });
        }
        if (route === FIX_ROUTE) {
            const input = await bodyOf(request, CiFixParamSchema);
            if (input instanceof Response) {
                return input;
            }
            // The turn is whoever pressed: the daemon vouches for them on the request, and nothing here stands in for them.
            return caller === undefined ? json(401, { error: "the sandbox did not say who pressed Fix" }) : await fix(repair, input, caller);
        }
        return undefined;
    } catch (error) {
        return json(statusOf(AnsweredSchema.safeParse(error)), { error: errorMessage(error) });
    }
};
