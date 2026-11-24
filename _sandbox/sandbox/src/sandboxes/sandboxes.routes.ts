import type { FleetConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Context } from "hono";
import { cardDeps } from "../conversations/actor/card-deps.js";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { answerResponse, type CliAnswer, cliBody } from "../http/cli-answer.js";
import { z } from "zod";
import { manageDeviceSandbox,heldHostDevices } from "../hosts/device-reports.js";
import { hostRunningSelf } from "../hosts/self-host.js";
import { hostRunningSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { fleetList, fleetProvision, fleetRemove } from "./fleet-client.js";
import { createSandboxThroughFleet, listFleet, removeSandboxThroughFleet } from "./fleet-gate.js";
import { approveMove, type MoveGateDeps, type MoveProgress, runMove } from "./move-gate.js";
import { relayThroughTunnels } from "./move-relay.js";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import { soleLiveConversation, turnRunOf } from "../conversations/actor/conversation-holdings.js";
import { type TurnStanding, turnStandingOf } from "../conversations/actor/turn-standing.js";
import { holdDepsOf } from "../guard/held-asks.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { turnClaimOf, unprovenTurnWords } from "../seams/workload-stamp.js";

/* The `sandboxes` CLI's four routes, scoped to the agent token like the wallet's and the capability ask's. */

// A body field as a non-empty string, or absent. Every field of a create but the name is optional, and the difference
// between "" and missing is not one worth carrying past the door.
const filled = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

// Read fresh per call, so connecting or re-connecting the capability applies to the very next command rather than to
// the next boot.
const fleetEntry = async (services: Services): Promise<FleetConfig | undefined> => {
    const entry = (await services.capabilities.list()).find((capability) => capability.kind === "fleet");
    return entry?.kind === "fleet" ? entry.config : undefined;
};

// Which machines this sandbox can act on. `host`-kind capabilities are the connected computers; `self` is the one
// running this container, when that has already been read (never forced, so a sleeping laptop costs nothing here).
const reachableDevices = async (services: Services): Promise<{ ids: readonly string[]; self: string | undefined }> => ({
    ids: (await services.capabilities.list()).filter((capability) => capability.kind === "device").map((capability) => capability.id),
    self: await hostRunningSelf(services),
});

// A role's shelves, or the reach of the people a conversation works for, can leave the fleet card out of a turn
// (turn-standing.ts): its CLI's routes then refuse that turn too, rather than answering for the sandbox. A shell no
// planned turn owns (a person's own terminal) is answered as before, and the card on every create still stands.
// Undefined lets the call through; otherwise the sentence to refuse it with.
export const fleetWithheld = (fleetId: string | undefined, standing: Pick<TurnStanding, "granted"> | undefined): string | undefined =>
    fleetId === undefined || standing === undefined || standing.granted.includes(fleetId)
        ? undefined
        : `This conversation's turn was not given the "${fleetId}" card: its role leaves the sandbox shelf shut, or the people it ` +
          "works for were not given the owner's account. Nothing was listed or created; carry on without it and say what you left undone.";

// The turn a call comes from, when it proves which (seams/workload-stamp.ts): the one its cards are raised in. A name
// without its proof is refused (2026-11-24): believed, it put another conversation's card, and its withholding, in play.
// A shell naming none is held to the one live turn's withholding, as an agent that unset its stamp would be.
const callerTurn = async (services: Services, c: Context<AppEnv>): Promise<{ readonly refused: Response } | { readonly conversationId: string | undefined }> => {
    const claim = turnClaimOf((name) => c.req.header(name));
    if (claim.kind === "unproven") {
        return { refused: c.json({ error: { type: "unproven", message: unprovenTurnWords(claim.named) } }, 403) };
    }
    const conversationId = claim.kind === "proven" ? claim.conversationId : undefined;
    const held = conversationId ?? soleLiveConversation(services.conversations);
    const fleet = (await services.capabilities.list()).find((capability) => capability.kind === "fleet");
    const refused = fleetWithheld(fleet?.id, held === undefined ? undefined : turnStandingOf(services.conversations, held));
    return refused === undefined ? { conversationId } : { refused: c.json({ error: { type: "withheld", message: refused } }, 403) };
};

// What the move gate stands on, from this daemon: the readings already held, the card switches, its own slug, and the
// tunnels a relayed move is pumped through.
const moveDeps = (services: Services, base: Pick<MoveGateDeps, "runFlow" | "hold"> & ReturnType<typeof cardDeps>): MoveGateDeps => ({
    ...base,
    devices: () => heldHostDevices(services),
    manages: async (card: string) =>
        (await services.capabilities.list()).some((capability) => capability.kind === "device" && capability.id === card && capability.config.sandboxes === "on"),
    selfSlug: () => sandboxSlugOf(services.config.sandbox.name),
    relay: relayThroughTunnels(services.deviceTunnels),
});

// A move's body: what to move, where, under which manager, and the agent's case. Blank strings read as absent.
const blank = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());
const MoveBodySchema = z.object({
    name: z.string().optional().transform(blank),
    to: z.string().optional().transform(blank),
    manager: z.enum(["ic", "compose"]).optional(),
    why: z.string().optional().transform(blank),
});

// A move's answer once it is under way: one JSON object a line, its progress as it comes and its outcome last, so a
// CLI that holds the connection for the hours a copy takes prints where it is rather than nothing.
const streamedMove = (run: (onProgress: (progress: MoveProgress) => void) => Promise<CliAnswer>): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
            const send = (line: string): void => controller.enqueue(encoder.encode(`${line}\n`));
            const answer = await run((progress) => send(JSON.stringify({ progress })));
            // The answer's body is already JSON (cli-answer.ts), carried as it is.
            send(`{"status":${answer.status},"answer":${answer.body}}`);
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
};

const createSandboxesRoutes = (services: Services) => {
    const deps = {
        token: async () => (await fleetEntry(services))?.token,
        list: (token: string) => fleetList(services.config, token),
        provision: (token: string, ask: { name: string; definition?: string }) => fleetProvision(services.config, token, ask),
        devices: () => reachableDevices(services),
        runFlow: (id: string, flow: Parameters<typeof manageDeviceSandbox>[2]) => manageDeviceSandbox(services, id, flow),
        remove: (token: string, sandboxId: string) => fleetRemove(services.config, token, sandboxId),
        runsOn: async (slug: string) => hostRunningSandbox(await heldHostDevices(services), slug),
        selfUrl: () => services.config.sandbox.publicUrl,
        ...cardDeps(services),
        hold: holdDepsOf(services.heldCards, (conversationId) => turnRunOf(services.conversations, conversationId)),
    };
    return {
        list: async (c: Context<AppEnv>): Promise<Response> => {
            const turn = await callerTurn(services, c);
            return "refused" in turn ? turn.refused : answerResponse(c, await listFleet(deps));
        },
        create: async (c: Context<AppEnv>): Promise<Response> => {
            const turn = await callerTurn(services, c);
            if ("refused" in turn) {
                return turn.refused;
            }
            const body = await cliBody(c, "create", '{"name":"…"}');
            if (body instanceof Response) {
                return body;
            }
            const { name, on, definition, why } = body;
            const asked = filled(name);
            if (asked === undefined) {
                return c.json({ error: { type: "invalid_request", message: "`name` is what the new sandbox will be called" } }, 400);
            }
            const answer = await createSandboxThroughFleet(deps, {
                name: asked,
                on: filled(on),
                definition: filled(definition),
                why: filled(why),
                conversationId: turn.conversationId,
                signal: c.req.raw.signal,
            });
            return answerResponse(c, answer);
        },
        move: async (c: Context<AppEnv>): Promise<Response> => {
            const turn = await callerTurn(services, c);
            if ("refused" in turn) {
                return turn.refused;
            }
            const body = await cliBody(c, "move", '{"name":"…","to":"…"}');
            if (body instanceof Response) {
                return body;
            }
            const parsed = MoveBodySchema.safeParse(body);
            const { name, to, manager, why } = parsed.success ? parsed.data : {};
            if (name === undefined || to === undefined) {
                return c.json(
                    { error: { type: "invalid_request", message: "`name` is the sandbox to move, `to` the computer it goes to, and `manager` (optional) ic or compose" } },
                    400,
                );
            }
            const gate = moveDeps(services, deps);
            const approved = await approveMove(gate, {
                name,
                to,
                manager,
                why,
                conversationId: turn.conversationId,
                signal: c.req.raw.signal,
            });
            if ("status" in approved) {
                return answerResponse(c, approved);
            }
            return streamedMove((onProgress) => runMove(gate, approved.route, { id: approved.id, plan: approved.plan, manager }, onProgress));
        },
        remove: async (c: Context<AppEnv>): Promise<Response> => {
            const turn = await callerTurn(services, c);
            if ("refused" in turn) {
                return turn.refused;
            }
            const body = await cliBody(c, "remove", '{"name":"…"}');
            if (body instanceof Response) {
                return body;
            }
            const { name, why } = body;
            const asked = filled(name);
            if (asked === undefined) {
                return c.json({ error: { type: "invalid_request", message: "`name` is the sandbox to remove, as `sandboxes ls` names it" } }, 400);
            }
            const answer = await removeSandboxThroughFleet(deps, {
                name: asked,
                why: filled(why),
                conversationId: turn.conversationId,
                signal: c.req.raw.signal,
            });
            return answerResponse(c, answer);
        },
    };
};

// The `sandboxes` CLI: the owner's other sandboxes, and the one door a new one is created through. `/sandboxes`
// rather than `/fleet`, which the conversation-fleet reads already own.
export const sandboxesRawRoutes = defineRawRoutes((services: Services) => {
    const sandboxRoutes = createSandboxesRoutes(services);
    return {
        "GET /sandboxes": sandboxRoutes.list,
        "POST /sandboxes": sandboxRoutes.create,
        "POST /sandboxes/remove": sandboxRoutes.remove,
        "POST /sandboxes/move": sandboxRoutes.move,
    };
});
