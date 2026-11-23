import { join } from "node:path";
import { RUNNER_SUBAGENTS_DOOR_HEADER, type RunnerSubagentNoTool } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { childSupervisor } from "../../agent/subagents/children.js";
import { subagentTools, type ServerTool } from "../../agent/subagents/waiting/subagent-wait.js";
import { workflowTools } from "../../agent/subagents/workflows/script-run-tools.js";
import { scriptRunDoor } from "../../agent/subagents/workflows/script-runs.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { PARENT_RUN_TOOLS } from "../../agent/subagents/waiting/parent-forward.js";
import { placedOnRunner, type RunnerFleetDeps } from "./runner-fleet.routes.js";

/* THE PARENT'S SUBAGENTS DOOR FOR ITS RUNNERS (2026-11-23). A turn this sandbox placed on a runner runs there as a local
   turn, and its `subagents` tools once acted on the runner's registry, so a child it spawned was the runner's: placed by
   the runner, off this board, never supervised or landed here. The runner hands each such call here (parent-subagents.ts),
   and it runs through the very tool handlers a turn of that conversation running here gets (subagent-wait.ts
   subagentTools), with that conversation's children engine and workflow runs, so the child is this sandbox's like any:
   placed by its fleet rules (here, on a runner, that same runner), cut and landed as a child of a parent on a runner is
   (land-target.ts: as any conversation lands), on this board, and its report wakes the conversation here, whose next turn
   is dispatched to the runner as every wake is. The trust is the fleet door's (runner-fleet.routes.ts): the runner's own
   bearer, the runner proved the turn is that conversation's, and this sandbox chose to run that conversation there. The
   runner mounted these tools only where the turn's role may delegate, as it would here. */

/** The tools a turn of `conversationId` running here would get, over this sandbox's registry; `signal` ends a wait. */
export type ParentToolsFor = (conversationId: string, signal: AbortSignal) => readonly ServerTool[];

const ArgsSchema = z.looseObject({});

const noTool = (c: Context<AppEnv>, tool: string): Response => {
    const refusal: RunnerSubagentNoTool = { ok: false, tool: false, message: `This sandbox runs no \`${tool}\` for its runners' turns.` };
    return c.json(refusal, 404, { [RUNNER_SUBAGENTS_DOOR_HEADER]: "1" });
};

// A refusal the turn reads as the tool's own answer, so a bad call costs it a retry, never a broken link.
const refused = (c: Context<AppEnv>, message: string): Response =>
    c.json({ content: [{ type: "text", text: JSON.stringify({ ok: false, message }) }], isError: true }, 200, { [RUNNER_SUBAGENTS_DOOR_HEADER]: "1" });

const argsOf = async (c: Context<AppEnv>): Promise<z.infer<typeof ArgsSchema> | undefined> => {
    try {
        const parsed = ArgsSchema.safeParse(await c.req.json());
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a body that is not JSON is refused as such by the caller
        return undefined;
    }
};

/** One tool call from a runner's turn, run here for the conversation placed on it. */
export const runnerSubagentsDoor =
    (services: RunnerFleetDeps, toolsFor: ParentToolsFor) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const placed = await placedOnRunner(services, c, RUNNER_SUBAGENTS_DOOR_HEADER);
        if (placed instanceof Response) {
            return placed;
        }
        const name = c.req.param("tool") ?? "";
        // The runner's dropped link aborts the request, which ends a wait parked on it.
        const tool = PARENT_RUN_TOOLS.has(name) ? toolsFor(placed, c.req.raw.signal).find((candidate) => candidate.name === name) : undefined;
        if (tool === undefined) {
            return noTool(c, name);
        }
        const args = await argsOf(c);
        if (args === undefined) {
            return refused(c, `The \`${name}\` call's arguments did not arrive as a JSON object.`);
        }
        // Checked as the SDK checks a call before its handler runs.
        const checked = z.object(tool.inputSchema).safeParse(args);
        if (!checked.success) {
            return refused(c, `The \`${name}\` call's arguments do not fit the tool: ${checked.error.message}`);
        }
        const result = await tool.handler(checked.data, {});
        return c.json(result, 200, { [RUNNER_SUBAGENTS_DOOR_HEADER]: "1" });
    };

/** The tools a turn of this conversation gets here, on this sandbox's children engine and workflow runs. */
const parentToolsFor =
    (services: Services): ParentToolsFor =>
    (conversationId, signal) => {
        // This sandbox's copy of the conversation's checkout, as the parent turn's own tree is named here.
        const parent = { conversationId, cwd: services.agentWorktrees.conversationDir(conversationId) };
        return subagentTools({
            conversationId,
            conversations: services.conversations,
            signal,
            children: childSupervisor(services, parent),
            extraTools: workflowTools(scriptRunDoor(services, parent), signal),
            logsDir: join(services.config.historyRoot, "logs"),
            // Bounded on the runner, where the rest is kept for its turn to retrieve (agent/subagents/waiting/parent-forward.ts).
            wholeReports: true,
        });
    };

export const runnerSubagentsRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /system/runners/subagents/{tool}": runnerSubagentsDoor(services, parentToolsFor(services)),
}));
