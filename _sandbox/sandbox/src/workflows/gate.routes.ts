import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { GATE_DAILY_MAX_DEFAULT, type GateVerdict } from "@intentic/sandbox-contract/schemas/workflows";
import { workflowFaults, workflowRunFaults } from "@intentic/sandbox-contract/text/workflow-faults";
import type { Context } from "hono";
import { PAYLOAD_MAX } from "../automations/scheduler.js";
import { presentedDoorToken } from "../auth/tokens/door-tokens.js";
import { sessionStart } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { dailyBudget } from "../store/daily-budget.js";
import { readBoundedText } from "../http/bounded-body.js";
import { gateVerdictOf } from "./workflow-gate.js";
import { openRun, runWorkflow, stopWorkflowRun } from "./workflow-runner.js";
import { defineRawRoutes } from "../http/raw-route-server.js";

// Release gate: the daemon's identity-less door that answers synchronously, running exactly the workflow named in the
// URL. Token-authed (query or bearer), since pipeline callers send no Origin; the gate's presence is its own enable
// toggle, and calls run unserialized since each derives its own run and conversation id.

// Per-workflow daily ceiling, keyed by workflow id so each gate gets its own day.
const daily = dailyBudget();

// Default wait with no caller deadline, and the ceiling regardless of what they ask.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 3 * 3_600;

const waitMsOf = (raw: string | undefined): number => {
    const asked = Number(raw);
    if (!Number.isFinite(asked) || asked <= 0) {
        return WAIT_DEFAULT_S * 1_000;
    }
    return Math.min(asked, WAIT_MAX_S) * 1_000;
};

// Under both the 125 s an edge proxy (Cloudflare) waits between origin bytes and the 300 s a Node fetch waits per chunk.
export const HEARTBEAT_MS = 30_000;

const encoder = new TextEncoder();

// Headers leave at once and a space every beat until the verdict: whitespace JSON allows before a value, so callers that
// read the whole body still parse one verdict. A caller that hangs up can no longer be answered, so its run is stopped.
const verdictStream = (verdict: Promise<GateVerdict>, hangUp: () => void, heartbeatMs: number): Response => {
    let beat: ReturnType<typeof setInterval> | undefined;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            beat = setInterval(() => controller.enqueue(encoder.encode(" ")), heartbeatMs);
            void verdict.then((answer) => {
                clearInterval(beat);
                if (open) {
                    controller.enqueue(encoder.encode(JSON.stringify(answer)));
                    controller.close();
                }
            });
        },
        cancel() {
            open = false;
            clearInterval(beat);
            hangUp();
        },
    });
    // no-transform: compressing means reading the body whole, which would hold the headers and every heartbeat until the
    // verdict, here (compress-responses.ts) and at an edge proxy alike.
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store, no-transform" } });
};

export const createGateRoute =
    (services: Services, heartbeatMs = HEARTBEAT_MS) =>
    async (c: Context<AppEnv, "/workflows/:id/gate">): Promise<Response> => {
        const workflow = await services.workflows.get(c.req.param("id"));
        // One 404 for both no such workflow and no gate declared; nothing here is fixable by learning which.
        if (workflow?.gate === undefined) {
            return c.json({ error: "no gated workflow with that id" }, 404);
        }
        const { gate } = workflow;
        // Door credential via `?token=` or bearer header; a gate saved before the token store existed admits nobody.
        if (!(await services.doorTokens.verify("gate", workflow.id, presentedDoorToken(c.req.raw.headers, c.req.query("token"))))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        // Re-checked at call time: a hand-edited manifest may name a field that no longer exists.
        const faults = workflowFaults(workflow);
        if (faults.length > 0) {
            return c.json({ error: faults.join(" ") }, 400);
        }
        // Read with the cap counted as it streams, before anything is spent: a chunked body declares no length, and
        // reading one whole and slicing it after is the memory the limit exists to protect.
        const body = await readBoundedText(c.req.raw, PAYLOAD_MAX);
        if (body.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        if (body.kind === "invalid") {
            return c.json({ error: "the body is not UTF-8 text" }, 400);
        }
        // Same admission guard as every automation wake; a refusal must happen before the day's budget is spent.
        const { admission } = await services.sandboxSettings.get();
        const admitted = guard(sessionStart, { source: "workflow", admission });
        if (admitted.effect !== "allow") {
            return c.json({ error: admitted.reason }, 403);
        }
        if (daily.spend(workflow.id, gate.dailyMax ?? GATE_DAILY_MAX_DEFAULT, Date.now())) {
            return c.json({ error: "this gate has reached today's run limit" }, 429);
        }

        // Request body becomes the run's request, appended to every step's prompt; the daemon never parses it.
        const request = body.value;
        // Refused before the first step spends a session; 400, since the body is the caller's.
        const runFaults = workflowRunFaults(workflow, request);
        if (runFaults.length > 0) {
            return c.json({ error: runFaults.join(" ") }, 400);
        }
        const repos = await services.agentWorktrees.snapshot();
        if (repos.length === 0) {
            return c.json({ error: "the workspace has no committed repository snapshot to run from" }, 409);
        }
        const run = await services.workflowRuns.start(openRun(workflow, repos, Date.now(), request === "" ? undefined : request));

        // Holding the connection is the point: a pipeline step blocks until it knows rather than polling. The run
        // promise is caught so a rejection past the deadline is not left unhandled.
        const finished = runWorkflow(services, run).then(
            () => true,
            () => true,
        );
        const waitMs = waitMsOf(c.req.query("wait"));
        const verdict = (async (): Promise<GateVerdict> => {
            const settled = await settledWithin(finished, waitMs);
            // A given-up caller must not leave the fan-out running: stop it rather than abandon it.
            if (!settled) {
                stopWorkflowRun(run.runId);
            }
            // Verdict is read back from the run ledger, not reasoned about; a run past the end of it reads as blocked.
            const record = await services.workflowRuns.get(run.runId);
            return record === undefined
                ? { outcome: "blocked", runId: run.runId, reason: "The run went missing before it could be read." }
                : gateVerdictOf(record);
        })().catch((error: unknown): GateVerdict => ({ outcome: "blocked", runId: run.runId, reason: `The run could not be read: ${errorMessage(error)}` }));

        // Always 200, even for `fail`: the pipeline reads `outcome` itself, distinct from a wrong-token failure.
        return verdictStream(verdict, () => stopWorkflowRun(run.runId), heartbeatMs);
    };

// Whether `work` settled within `ms`. The deadline runs up to three hours, so its timer is cleared the moment the race
// ends either way, never left armed for hours behind a run that finished in seconds, and unref'd so it never keeps a
// stopping daemon up.
export const settledWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
    const deadline = new AbortController();
    try {
        return await Promise.race([work.then(() => true), sleep(ms, { signal: deadline.signal, unref: true }).then(() => false)]);
    } finally {
        deadline.abort();
    }
};

// The release gate: a pipeline runner POSTs here and waits for the verdict, authenticated by the workflow's own
// minted gate token.
// The only route in the daemon that holds a request open for the work it started.
export const gateRawRoutes = defineRawRoutes((services: Services) => ({ "POST /workflows/{id}/gate": createGateRoute(services) }));
