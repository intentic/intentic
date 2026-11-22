import {
    RUNNER_FLEET_CONVERSATION_HEADER,
    RUNNER_FLEET_DOOR_HEADER,
    type RunnerFleetNotPlaced,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { conversationTurnReader } from "../../auth/scope/turn-reader.js";
import type { Services } from "../../composition.js";
import { recordedPromptReader } from "../../agent/prompt/prompt-disclosure.js";
import { createFleetReads } from "../../conversations/recall/fleet-reads.js";
import { worktreeOf } from "../../conversations/registry/agents-store.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { bearerPeer } from "../../peers/peer-store.js";

/* THE PARENT'S FLEET DOOR FOR ITS RUNNERS (2026-11-22). A turn this sandbox placed on a runner runs there as a local turn,
   so its `agents ls|find|show|bundle` asked the runner's daemon, which knows only the turns it ran: no other conversation,
   and not even this one's turns that ran here. Every record is here, so the runner asks here (parent-fleet.ts), and is
   answered exactly as `GET /fleet…` answers a turn of that conversation running here: what its people may read, its own
   conversation always. On the runner's own bearer, and only for a conversation placed on that runner, the trust the wake
   door already rests on (ownership/wake.routes.ts): the runner proved the turn is that conversation's, and this sandbox
   chose to run that conversation there. Reads only; nothing here can change anything. */

export type RunnerFleetDeps = Pick<Services, "runners" | "agents">;

/** Undefined when the request is a runner reading for a conversation placed on it; otherwise the answer that refuses it. */
const refuseUnplaced = async (services: RunnerFleetDeps, c: Context<AppEnv>): Promise<Response | undefined> => {
    const runner = await bearerPeer(services.runners, c);
    if (runner instanceof Response) {
        return runner;
    }
    const conversationId = c.req.header(RUNNER_FLEET_CONVERSATION_HEADER) ?? "";
    if (conversationId !== "" && worktreeOf(services.agents.entry(conversationId))?.runner === runner) {
        return undefined;
    }
    // Said apart from a handle nobody answers to, so the runner reads its own record instead: a conversation this sandbox
    // never placed there (a child a runner turn started) is the runner's.
    const refusal: RunnerFleetNotPlaced = {
        ok: false,
        placed: false,
        message: `This sandbox placed no conversation ${conversationId === "" ? "" : `\`${conversationId}\` `}on the runner "${runner}".`,
    };
    return c.json(refusal, 404, { [RUNNER_FLEET_DOOR_HEADER]: "1" });
};

/** One fleet read behind the door: answered only for a runner reading for a conversation placed on it. */
export const runnerFleetDoor =
    (services: RunnerFleetDeps, read: (c: Context<AppEnv>) => Promise<Response>) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const refused = await refuseUnplaced(services, c);
        if (refused !== undefined) {
            return refused;
        }
        const answer = await read(c);
        answer.headers.set(RUNNER_FLEET_DOOR_HEADER, "1");
        return answer;
    };

export const runnerFleetRawRoutes = defineRawRoutes((services: Services) => {
    // Called only once the door has let the request through, so the header names a conversation placed on that runner.
    const reads = createFleetReads(
        services,
        async (c) => await conversationTurnReader(services, c.req.header(RUNNER_FLEET_CONVERSATION_HEADER) ?? ""),
        recordedPromptReader(services.promptRecord, services.workspace.root),
    );
    const behind = (read: (c: Context<AppEnv>) => Promise<Response>) => runnerFleetDoor(services, read);
    return {
        "GET /system/runners/fleet": behind(reads.list),
        "GET /system/runners/fleet/{handle}": behind(reads.show),
        "GET /system/runners/fleet/{handle}/bundle": behind(reads.bundle),
    };
});
