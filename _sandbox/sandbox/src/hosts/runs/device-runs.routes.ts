import { errorMessage } from "@intentic/base/errors";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { insideRel } from "@intentic/base/contained";
import { isIsolated } from "../../conversations/registry/agents-store.js";
import { ROOT_REPO } from "../../workspace/layout/repo-discovery.js";
import { bodyOf, callerName, type DoorServices, RUN_VIEW, refusalFor } from "../device-door.routes.js";

// WHAT A PROGRAM STARTED ON ONE OF THE OWNER'S COMPUTERS IS DOING, AND ITS STOP, from a shell (`devices stop`, and
// `devices run` following its program and stopping it on Ctrl+C). Held to the same rule as the rest of the `devices`
// door (device-door.routes.ts); the runs themselves are device-runs.ts.

type RunDoorServices = DoorServices & Pick<Services, "deviceRuns" | "runBuilds" | "agents" | "workspace">;

// Why a shell stops a program, which with who it is says who stopped it on the computer's record: `stop` is
// `devices stop`, `replace` a `devices run` whose new build replaces the target's run, `interrupt` Ctrl+C in a terminal
// following it.
const StopWhySchema = z.enum(["stop", "replace", "interrupt"]);

export const stopperName = (caller: string, why: z.infer<typeof StopWhySchema>): string => {
    const fromView = caller === RUN_VIEW;
    switch (why) {
        case "replace":
            return fromView ? "Run pressed again in the Run view (its new build replaced it)" : `\`devices run\` from ${caller}, whose new build replaced it`;
        case "interrupt":
            return fromView ? "Ctrl+C in its Run terminal" : `Ctrl+C in \`devices\` from ${caller}`;
        case "stop":
            return `\`devices stop\` from ${caller}`;
    }
};

// Stop by run id, or every running program of one name (a run target's): what `devices stop` and `devices run`'s
// replacing of its previous run send.
const StopSchema = z
    .object({
        id: z.string().min(1).max(200).optional(),
        name: z.string().min(1).max(100).optional(),
        force: z.boolean().optional(),
        why: StopWhySchema.default("stop"),
    })
    .strict()
    .refine((stop) => (stop.id === undefined) !== (stop.name === undefined), "name a run `id` or a program `name`, one of the two");

const OutputQuerySchema = z.object({
    since: z.coerce.number().int().nonnegative().optional(),
    lines: z.coerce.number().int().positive().max(2000).default(200),
});

// A `devices run` about to build: the repository it builds in, by the folder it stands in or, for a run the editor
// started, the repository the editor named.
const BuildSchema = z
    .object({
        dir: z.string().min(1).max(1000),
        repo: z.string().min(1).max(500).optional(),
        target: z.string().min(1).max(100),
        device: z.string().min(1).max(100),
    })
    .strict();

// How often `devices run` renews its build's hold, well inside RENEW_LAPSE_MS.
const RENEW_EVERY_MS = 20_000;

// The repository a build holds, or why it holds none: an isolated conversation builds in its own checkout, which no land
// writes into, and a folder outside the workspace is nobody's land target.
const heldRepoOf = (services: RunDoorServices, c: Context<AppEnv>, build: z.infer<typeof BuildSchema>): { repo: string } | { why: string } => {
    const named = c.req.header("x-intentic-conversation");
    const entry = named === undefined || named === "" || callerName(c) === RUN_VIEW ? undefined : services.agents.entry(named);
    if (entry !== undefined && isIsolated(entry)) {
        return { why: "this conversation builds in its own checkout, which nothing lands into" };
    }
    if (build.repo !== undefined) {
        return { repo: build.repo };
    }
    const inside = insideRel(services.workspace.root, build.dir);
    if (inside === undefined) {
        return { why: `${build.dir} is outside the workspace` };
    }
    return { repo: inside === "" ? ROOT_REPO : inside };
};

// While a run builds in the owner's tree, lands into that repository wait (run-builds.ts).
const createBuildHoldRoutes = (services: RunDoorServices) => ({
    // POST /devices/builds {dir, repo?, target, device}: hold the repository's lands for this build.
    hold: async (c: Context<AppEnv>): Promise<Response> => {
        const body = await bodyOf(c, BuildSchema);
        if (!body.ok) {
            return c.json({ error: body.error }, 400);
        }
        const where = heldRepoOf(services, c, body.value);
        if ("why" in where) {
            return c.json({ held: false, why: where.why });
        }
        const hold = services.runBuilds.hold({ repo: where.repo, target: body.value.target, device: body.value.device });
        return c.json({ held: true, id: hold.id, repo: hold.repo, renewEveryMs: RENEW_EVERY_MS });
    },
    // POST /devices/builds/{id}/renew: still building; false once the hold lapsed.
    renew: (c: Context<AppEnv>): Response => c.json({ held: services.runBuilds.renew(c.req.param("id") ?? "") }),
    // DELETE /devices/builds/{id}: the build ended; lands go on. Answers how many waited and how many landed anyway.
    release: (c: Context<AppEnv>): Response => {
        const released = services.runBuilds.release(c.req.param("id") ?? "");
        return c.json(released === undefined ? { released: false } : { released: true, ...released });
    },
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
            const { id, name, force, why } = body.value;
            const by = stopperName(callerName(c), why);
            const stopped =
                id === undefined
                    ? await services.deviceRuns.stopNamed(device, name ?? "", by)
                    : [{ id, text: await services.deviceRuns.stop(device, id, { force: force === true, by }) }];
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
    const builds = createBuildHoldRoutes(services);
    return {
        "POST /devices/builds": builds.hold,
        "POST /devices/builds/{id}/renew": builds.renew,
        "DELETE /devices/builds/{id}": builds.release,
        "GET /devices/{name}/apps": runs.list,
        "POST /devices/{name}/apps/stop": runs.stop,
        "GET /devices/{name}/apps/{id}/output": runs.output,
        "GET /devices/runs": runs.where,
    };
});
