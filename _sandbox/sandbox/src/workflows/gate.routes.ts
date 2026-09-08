import { setTimeout as sleep } from "node:timers/promises";
import { GATE_DAILY_MAX_DEFAULT, type GateVerdict, workflowFaults, workflowRunFaults } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { PAYLOAD_MAX } from "../automations/scheduler.js";
import { presentedDoorToken } from "../auth/door-tokens.js";
import { sessionStart } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { dailyBudget } from "../store/daily-budget.js";
import { gateVerdictOf } from "./workflow-gate.js";
import { openRun, runWorkflow, stopWorkflowRun } from "./workflow-runner.js";

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

export const createGateRoute =
    (services: Services, wake: TurnFn = streamAgent) =>
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
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
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
        const request = (await c.req.text()).slice(0, PAYLOAD_MAX);
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
        const finished = runWorkflow(services, run, wake).then(
            () => true,
            () => true,
        );
        const settled = await Promise.race([finished, sleep(waitMsOf(c.req.query("wait"))).then(() => false)]);
        // A given-up caller must not leave the fan-out running: stop it rather than abandon it.
        if (!settled) {
            stopWorkflowRun(run.runId);
        }

        // Verdict is read back from the run ledger, not reasoned about; a run past the end of it reads as blocked.
        const record = await services.workflowRuns.get(run.runId);
        const verdict: GateVerdict =
            record === undefined
                ? { outcome: "blocked", runId: run.runId, reason: "The run went missing before it could be read." }
                : gateVerdictOf(record);

        // Always 200, even for `fail`: the pipeline reads `outcome` itself, distinct from a wrong-token failure.
        return c.json(verdict);
    };
