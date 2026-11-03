import { errorMessage } from "@intentic/base/errors";
import type { Context } from "hono";
import { z } from "zod";
import { MAX_STOP_GRACE_SECONDS } from "@intentic/sandbox-contract/schemas/run-targets";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { callTool } from "./device-reports.js";
import { startedRun } from "./runs/device-runs.js";
import { defineRawRoutes } from "../http/raw-route-server.js";

// WHO MAY ACT ON ONE OF THE OWNER'S COMPUTERS FROM A SHELL IN THE SANDBOX: the `devices` command's routes (push a build,
// start it, reach its ports). Two callers, one rule each:
// - an agent's shell: the conversation it names must have a live turn that mounts that computer, so a persona that
//   withholds a computer withholds these too;
// - a run the owner started from the editor (`runs.start`): its terminal carries a grant minted for that one computer,
//   which ends with the run.
// What the computer itself allows is still the computer's to say: its switches are checked there, on every call.
// The run grants themselves are minted in device-door.ts.

export type DoorServices = Pick<Services, "conversations" | "hostHub" | "turnMounts" | "runGrants">;

// Undefined when the caller may act on `device`; otherwise the refusal to answer with.
export const refusalFor = (services: DoorServices, c: Context<AppEnv>, device: string): { status: 400 | 403; error: string } | undefined => {
    const grant = c.req.header("x-intentic-run-grant");
    if (grant !== undefined && grant !== "") {
        return services.runGrants.allows(grant, device)
            ? undefined
            : {
                  status: 403,
                  error: `this run may act on its own computer only, and only while it lasts; "${device}" is not it, or the run has ended`,
              };
    }
    const named = c.req.header("x-intentic-conversation");
    const conversationId = named !== undefined && named !== "" ? named : soleLiveConversation(services.conversations);
    if (conversationId === undefined) {
        return { status: 400, error: "no conversation named: run this from an agent's shell, or from a run started in the editor" };
    }
    if (!services.turnMounts.reaches(conversationId, { kind: "device", id: device })) {
        return {
            status: 403,
            error: `this conversation's turn does not reach a device called "${device}": use a computer whose tools this turn has (mcp__<name>__…)`,
        };
    }
    return undefined;
};

const StartSchema = z
    .object({
        program: z.string().min(1).max(1000),
        // The sandbox's own bookkeeping, not app_start's: the repository a `devices run` came from, and the ports it
        // opened for the program (`reach`), closed again when the program is stopped.
        repo: z.string().max(500).optional(),
        reach: z.array(z.int().min(1).max(65535)).max(16).optional(),
        args: z.array(z.string().max(4000)).max(100).optional(),
        env: z.record(z.string(), z.string().max(4000)).optional(),
        cwd: z.string().max(1000).optional(),
        name: z.string().max(100).optional(),
        isolated: z.boolean().optional(),
        network: z.boolean().optional(),
        stopGraceSeconds: z.int().min(1).max(MAX_STOP_GRACE_SECONDS).optional(),
    })
    .strict();

const TunnelSchema = z.object({ port: z.int().min(1).max(65535), as: z.int().min(1).max(65535).optional() }).strict();

export const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    // A body that is not JSON is read as none, which the schema then refuses by name; any other failure is not the caller's.
    const raw: unknown = await c.req.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    });
    const parsed = schema.safeParse(raw);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : {
              ok: false,
              error: `bad request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`,
          };
};

export type DeviceDoorServices = DoorServices & Pick<Services, "deviceTunnels" | "deviceRuns">;

const createDeviceDoorRoutes = (services: DeviceDoorServices) => ({
    // POST /devices/{name}/apps: the device's own app_start, for a shell (`devices run`); it answers as the tool does.
    start: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        const body = await bodyOf(c, StartSchema);
        if (!body.ok) {
            return c.json({ error: body.error }, 400);
        }
        const { repo, reach, ...start } = body.value;
        try {
            const { text, refused: toolRefused } = await callTool(services, device, "app_start", start, AbortSignal.timeout(60_000));
            if (toolRefused) {
                return c.json({ error: text }, 409);
            }
            const run = startedRun(text);
            if (run === undefined) {
                return c.json({ device, text });
            }
            services.deviceRuns.started(device, run.id, {
                name: start.name ?? run.id.replace(/-[0-9a-f]{6}$/, ""),
                repo,
                ports: reach ?? [],
                ended: run.ended,
                stopGraceSeconds: start.stopGraceSeconds,
            });
            return c.json({ device, text, id: run.id, ended: run.ended });
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 502);
        }
    },
    // POST /devices/{name}/tunnels {port, as?}: the device's 127.0.0.1:<port> at the sandbox's 127.0.0.1:<as ?? port>.
    openTunnel: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        const body = await bodyOf(c, TunnelSchema);
        if (!body.ok) {
            return c.json({ error: body.error }, 400);
        }
        try {
            return c.json(await services.deviceTunnels.open(device, body.value.port, body.value.as));
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 409);
        }
    },
    // DELETE /devices/{name}/tunnels/{port}
    closeTunnel: async (c: Context<AppEnv>): Promise<Response> => {
        const device = c.req.param("name") ?? "";
        const refused = refusalFor(services, c, device);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        const port = Number(c.req.param("port"));
        return c.json({ closed: await services.deviceTunnels.close(device, port) });
    },
    // GET /devices/tunnels: every tunnel open now.
    listTunnels: (c: Context<AppEnv>): Response => c.json({ tunnels: services.deviceTunnels.list() }),
});

// The rest of the `devices` command, and a device's end of a `devices reach` tunnel, redeeming its one-time ticket.
export const deviceDoorRawRoutes = defineRawRoutes((services: DeviceDoorServices) => {
    const deviceDoor = createDeviceDoorRoutes(services);
    return {
        "POST /devices/{name}/apps": deviceDoor.start,
        "POST /devices/{name}/tunnels": deviceDoor.openTunnel,
        "DELETE /devices/{name}/tunnels/{port}": deviceDoor.closeTunnel,
        "GET /devices/tunnels": deviceDoor.listTunnels,
        "GET /system/hosts/tunnel": services.deviceTunnels.route,
    };
});
