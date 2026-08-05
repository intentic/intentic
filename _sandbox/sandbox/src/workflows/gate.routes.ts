import { setTimeout as sleep } from "node:timers/promises";
import { GATE_DAILY_MAX_DEFAULT, type GateVerdict, workflowFaults, workflowRunFaults } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/agent.routes.js";
import { PAYLOAD_MAX } from "../automations/scheduler.js";
import { tokenEquals } from "../auth/auth.js";
import { sessionStart } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { dailyBudget } from "../store/daily-budget.js";
import { gateVerdictOf } from "./workflow-gate.js";
import { openRun, runWorkflow, stopWorkflowRun } from "./workflow-runner.js";

/* THE RELEASE GATE — the daemon's third door for a caller with no identity, and the only one that ANSWERS.
 *
 * The Doorbell proved the shape: a route that is itself the source, normalizing an outside request and driving
 * the existing machinery rather than wrapping a second copy of it. This is that shape pointed at a workflow
 * instead of an agent turn, and the whole of what it adds is a wait and a verdict.
 *
 * WHY THIS IS NOT AN AUTOMATION. `/automations/{id}/fire` wakes one agent turn whose PROMPT may mention running
 * a workflow, which puts a model in the path of a dispatch that has to be deterministic: a pipeline cannot be
 * told "the gate probably ran". Here the workflow named in the URL is the workflow that runs, and nothing
 * decides otherwise.
 *
 * WHY IT IS TOKEN-AUTHED AND NOT ORIGIN-AUTHED. The Doorbell's gate is its embed-origin allowlist, which works
 * because its caller is a browser on a page the owner controls. A pipeline runner sends no Origin at all — the
 * Doorbell would refuse it by design — so this takes the event automation's model instead: a minted token in
 * the query string, the one mechanism every CI system can carry. Enforced ALWAYS, fail-closed even in loopback,
 * because the token always exists once a gate is declared.
 *
 * WHY THERE IS NO `enabled` TOGGLE. A workflow does not have one, on the argument that nothing fires it on its
 * own. Something does now — but the GATE's presence is the switch: declare one and the door opens, drop it and
 * the door is gone along with the token behind it. A second toggle would be a way to leave a token live on a
 * closed door.
 *
 * CONCURRENT CALLS ARE FINE and deliberately not serialized. Two pipelines gating two commits derive different
 * run ids and different conversation ids, so nothing is shared and nothing collides — which is the property
 * that makes "gate every pull request" a thing anyone can actually turn on.
 */

// The per-workflow daily ceiling. Keyed by workflow id, so two gates on one sandbox each get their own day.
const daily = dailyBudget();

/* How long the gate will hold the connection when the caller names no deadline of its own, and the longest it
 * will hold it whatever they name.
 *
 * The default is short on purpose. A pipeline that has not said how patient it is has a job timeout of its own
 * that this knows nothing about, and being cut off by the runner mid-wait is the one outcome that leaves a run
 * burning with nobody left to read it. The ceiling is generous because a real acceptance sweep across a dozen
 * stories is tens of minutes, and a gate that could not outlast the work it gates would be decorative.
 */
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
        // One 404 for "no such workflow" and for "that workflow declares no gate", unlike the Doorbell's
        // 404/403 split. There is nothing here for a caller to fix by learning which it was: a workflow with no
        // gate has no token either, so the request was never going to be admitted under any spelling.
        if (workflow?.gate === undefined) {
            return c.json({ error: "no gated workflow with that id" }, 404);
        }
        const { gate } = workflow;
        if (gate.token === undefined || !tokenEquals(c.req.query("token") ?? "", gate.token)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        /* Re-checked at call time, not only at save time: a manifest can be hand-edited, and a gate whose field
         * no longer exists would otherwise spend a full fan-out of sessions to discover it. The sentences are
         * the designer's own, so a broken gate reads the same in a pipeline log as it does under the canvas. */
        const faults = workflowFaults(workflow);
        if (faults.length > 0) {
            return c.json({ error: faults.join(" ") }, 400);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        /* ADMISSION — the same session.start guard every automation wake passes, with this door's own source.
         * The workflow floor is allow|deny only (a hold here is indistinguishable from a timeout to the CI
         * runner holding the connection), so a refusal answers 403 with the policy's sentence — a fact about
         * this workspace's configuration, which the caller's on-call can act on. Before the daily spend: a
         * refused call must not eat the day's budget. */
        const { admission } = await services.sandboxSettings.get();
        const admitted = guard(sessionStart, { source: "workflow", admission });
        if (admitted.effect !== "allow") {
            return c.json({ error: admitted.reason }, 403);
        }
        if (daily.spend(workflow.id, gate.dailyMax ?? GATE_DAILY_MAX_DEFAULT, Date.now())) {
            return c.json({ error: "this gate has reached today's run limit" }, 429);
        }

        /* The body becomes the run's REQUEST — the sentence every step is handed on top of its own prompt.
         * That seam already exists for the composer, and it is exactly the right one: the commit under test,
         * the preview URL it was deployed to, the branch, whatever this pipeline knows and the workflow's
         * prompts were written to expect. The daemon does not parse it, because what it means is the graph's
         * business and not this route's — which is the property that lets one door serve an acceptance sweep
         * and a security review without learning what either of them is. */
        const request = (await c.req.text()).slice(0, PAYLOAD_MAX);
        /* A design whose steps take their goal from the request cannot be run by a caller that sent an empty
         * body — there would be nothing to tell the model at all. Refused here rather than discovered by the
         * first step, because this door spends a whole fan-out of sessions per call and a gate wired into a
         * push-triggered pipeline would spend it on every commit. 400, not 500: the body is the caller's. */
        const runFaults = workflowRunFaults(workflow, request);
        if (runFaults.length > 0) {
            return c.json({ error: runFaults.join(" ") }, 400);
        }
        const run = await services.workflowRuns.start(openRun(workflow, Date.now(), request === "" ? undefined : request));

        /* Held, unlike every other run-starting route here — holding it IS the product. A pipeline step's whole
         * job is to block until it knows, and the alternative (ack now, make the caller poll) pushes the wait
         * into a shell loop in everybody's workflow file.
         *
         * The run promise is caught rather than left bare: past the deadline we walk away from it, and a
         * rejection landing after this handler has answered would otherwise be an unhandled one. */
        const finished = runWorkflow(services, run, wake).then(
            () => true,
            () => true,
        );
        const settled = await Promise.race([finished, sleep(waitMsOf(c.req.query("wait"))).then(() => false)]);
        /* A caller that gave up leaves a fan-out of sessions running with nobody to read them, so the deadline
         * STOPS the run rather than merely abandoning it. The steps are cut off where they stand, which is what
         * makes the timeout cost one deadline's worth of spend instead of the whole graph's. */
        if (!settled) {
            stopWorkflowRun(run.runId);
        }

        // Read back rather than reasoned about: the runner writes the documents and the step states, and the
        // verdict is a function of what is on the ledger. A run that rolled off the end of it reads as blocked.
        const record = await services.workflowRuns.get(run.runId);
        const verdict: GateVerdict =
            record === undefined
                ? { outcome: "blocked", runId: run.runId, reason: "The run went missing before it could be read." }
                : gateVerdictOf(record);

        /* ALWAYS 200, including for `fail`. The status code says whether the exchange worked; the body says
         * what the product is. Folding a failed gate into a 4xx would make `curl --fail` treat "your app is
         * broken" and "your token is wrong" as the same event, and those need opposite responses from whoever
         * is on call. The pipeline reads `outcome` and picks its own exit. */
        return c.json(verdict);
    };
