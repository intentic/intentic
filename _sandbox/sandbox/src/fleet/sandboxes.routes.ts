import type { FleetConfig } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { liveRequestRun } from "../agent/run/offer-request.js";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { manageDeviceSandbox } from "../hosts/device-reports.js";
import { hostRunningSelf } from "../hosts/self-host.js";
import { fleetList, fleetProvision } from "./fleet-client.js";
import { createSandboxThroughFleet, listFleet } from "./fleet-gate.js";

/* The `sandboxes` CLI's two routes, scoped to the agent token like the wallet's and the capability ask's. */

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
    ids: (await services.capabilities.list()).filter((capability) => capability.kind === "host").map((capability) => capability.id),
    self: await hostRunningSelf(services),
});

export const createSandboxesRoutes = (services: Services) => {
    const deps = {
        token: async () => (await fleetEntry(services))?.token,
        list: (token: string) => fleetList(services.config, token),
        provision: (token: string, ask: { name: string; definition?: string }) => fleetProvision(services.config, token, ask),
        devices: () => reachableDevices(services),
        runFlow: (id: string, flow: Parameters<typeof manageDeviceSandbox>[2]) => manageDeviceSandbox(services, id, flow),
        liveRun: liveRequestRun,
        observe: services.agents.observe,
    };
    return {
        list: async (c: Context<AppEnv>): Promise<Response> => {
            const answer = await listFleet(deps);
            return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
        },
        create: async (c: Context<AppEnv>): Promise<Response> => {
            let body: unknown;
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: { type: "invalid_request", message: 'the create body must be JSON: {"name":"…"}' } }, 400);
            }
            const { name, on, definition, why } = (body ?? {}) as Record<string, unknown>;
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
            return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
        },
    };
};
