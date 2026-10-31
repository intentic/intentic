import { errorMessage } from "@intentic/base/errors";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { bodyOf, type DoorServices, refusalFor } from "../device-door.routes.js";

// WHAT A PROGRAM STARTED ON ONE OF THE OWNER'S COMPUTERS IS DOING, AND ITS STOP, from a shell (`devices stop`, and
// `devices run` following its program and stopping it on Ctrl+C). Held to the same rule as the rest of the `devices`
// door (device-door.routes.ts); the runs themselves are device-runs.ts.

type RunDoorServices = DoorServices & Pick<Services, "deviceRuns">;

// Stop by run id, or every running program of one name (a run target's): what `devices stop` and `devices run`'s
// replacing of its previous run send.
const StopSchema = z
    .object({ id: z.string().min(1).max(200).optional(), name: z.string().min(1).max(100).optional(), force: z.boolean().optional() })
    .strict()
    .refine((stop) => (stop.id === undefined) !== (stop.name === undefined), "name a run `id` or a program `name`, one of the two");

const OutputQuerySchema = z.object({
    since: z.coerce.number().int().nonnegative().optional(),
    lines: z.coerce.number().int().positive().max(2000).default(200),
});

const createDeviceRunRoutes = (services: RunDoorServices) => ({
    // POST /devices/{name}/apps/stop {id} | {name}: the device's app_stop, and the ports opened for the program closed.
    stop: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        const body = await bodyOf(c, StopSchema);
        if (!body.ok) {
            return c.json({ error: body.error }, 400);
        }
        try {
            const { id, name, force } = body.value;
            const stopped =
                id === undefined
                    ? await services.deviceRuns.stopNamed(device, name ?? "")
                    : [{ id, text: await services.deviceRuns.stop(device, id, force === true) }];
            return c.json({ device, stopped });
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 409);
        }
    },
    // GET /devices/{name}/apps: what this sandbox started there, running and ended, as the device lists it.
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        try {
            return c.json({ device, runs: await services.deviceRuns.list(device) });
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 409);
        }
    },
    // GET /devices/{name}/apps/{id}/output[?since=<total>&lines=]: a run's state and what it printed (after `since`).
    output: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        const query = OutputQuerySchema.safeParse(c.req.query());
        if (!query.success) {
            return c.json(
                { error: `bad request: ${query.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` },
                400,
            );
        }
        try {
            return c.json(await services.deviceRuns.output(device, c.req.param("id") ?? "", query.data));
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 409);
        }
    },
    // GET /devices/runs: which computer holds each run this sandbox started since the daemon came up, for a
    // `devices stop <run-id>` that names no computer.
    where: (c: Context<AppEnv>): Response => {
        const id = c.req.query("id") ?? "";
        const device = services.deviceRuns.deviceOf(id);
        return device === undefined
            ? c.json({ error: `no run called "${id}" was started from this sandbox since it came up: pass --device` }, 404)
            : c.json({ id, device });
    },
});

export const deviceRunRawRoutes = defineRawRoutes((services: RunDoorServices) => {
    const runs = createDeviceRunRoutes(services);
    return {
        "GET /devices/{name}/apps": runs.list,
        "POST /devices/{name}/apps/stop": runs.stop,
        "GET /devices/{name}/apps/{id}/output": runs.output,
        "GET /devices/runs": runs.where,
    };
});
