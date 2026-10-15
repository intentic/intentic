import type { FleetConfig } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { cardDeps } from "../conversations/actor/card-deps.js";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { answerResponse, cliBody } from "../http/cli-answer.js";
import { manageDeviceSandbox,heldHostDevices } from "../hosts/device-reports.js";
import { hostRunningSelf } from "../hosts/self-host.js";
import { hostRunningSandbox } from "@intentic/sandbox-contract";
import { fleetList, fleetProvision, fleetRemove } from "./fleet-client.js";
import { createSandboxThroughFleet, listFleet, removeSandboxThroughFleet } from "./fleet-gate.js";
import { soleLiveConversation, turnRunOf } from "../conversations/actor/conversation-holdings.js";
import { type TurnStanding, turnStandingOf } from "../conversations/actor/turn-standing.js";
import { holdDepsOf } from "../guard/held-asks.js";

/* The `sandboxes` CLI's three routes, scoped to the agent token like the wallet's and the capability ask's. */

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

// A persona's shelves, or the reach of the people a conversation works for, can leave the fleet card out of a turn
// (turn-standing.ts): its CLI's routes then refuse that turn too, rather than answering for the sandbox. A shell no
// planned turn owns (a person's own terminal) is answered as before, and the card on every create still stands.
// Undefined lets the call through; otherwise the sentence to refuse it with.
export const fleetWithheld = (fleetId: string | undefined, standing: Pick<TurnStanding, "granted"> | undefined): string | undefined =>
    fleetId === undefined || standing === undefined || standing.granted.includes(fleetId)
        ? undefined
        : `This conversation's turn was not given the "${fleetId}" card: its persona leaves the sandbox shelf shut, or the people it ` +
          "works for were not given the owner's account. Nothing was listed or created; carry on without it and say what you left undone.";

const withheldFrom = async (services: Services, c: Context<AppEnv>): Promise<Response | undefined> => {
    const fleet = (await services.capabilities.list()).find((capability) => capability.kind === "fleet");
    const named = c.req.header("x-intentic-conversation");
    const conversationId = named !== undefined && named !== "" ? named : soleLiveConversation(services.conversations);
    const standing = conversationId === undefined ? undefined : turnStandingOf(services.conversations, conversationId);
    const refused = fleetWithheld(fleet?.id, standing);
    return refused === undefined ? undefined : c.json({ error: { type: "withheld", message: refused } }, 403);
};

export const createSandboxesRoutes = (services: Services) => {
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
            return (await withheldFrom(services, c)) ?? answerResponse(c, await listFleet(deps));
        },
        create: async (c: Context<AppEnv>): Promise<Response> => {
            const withheld = await withheldFrom(services, c);
            if (withheld !== undefined) {
                return withheld;
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
                conversationId: c.req.header("x-intentic-conversation"),
                signal: c.req.raw.signal,
            });
            return answerResponse(c, answer);
        },
        remove: async (c: Context<AppEnv>): Promise<Response> => {
            const withheld = await withheldFrom(services, c);
            if (withheld !== undefined) {
                return withheld;
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
                conversationId: c.req.header("x-intentic-conversation"),
                signal: c.req.raw.signal,
            });
            return answerResponse(c, answer);
        },
    };
};
