import { randomBytes } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { callTool } from "./device-reports.js";

// WHO MAY ACT ON ONE OF THE OWNER'S COMPUTERS FROM A SHELL IN THE SANDBOX: the `devices` command's routes (push a build,
// start it, reach its ports). Two callers, one rule each:
// - an agent's shell: the conversation it names must have a live turn that mounts that computer, so a persona that
//   withholds a computer withholds these too;
// - a run the owner started from the editor (`runs.start`): its terminal carries a grant minted for that one computer,
//   which ends with the run.
// What the computer itself allows is still the computer's to say: its switches are checked there, on every call.

// How long an owner's run may keep acting on its computer: a build and a session of looking at the app, not a standing
// key. The run's own end revokes it sooner.
const RUN_GRANT_MS = 4 * 60 * 60 * 1000;

export interface RunGrants {
    readonly mint: (device: string) => string;
    readonly allows: (grant: string, device: string) => boolean;
    readonly revoke: (grant: string) => void;
}

export const createRunGrants = (now: () => number = Date.now): RunGrants => {
    const grants = new Map<string, { readonly device: string; readonly until: number }>();
    return {
        mint: (device) => {
            const grant = randomBytes(24).toString("hex");
            grants.set(grant, { device, until: now() + RUN_GRANT_MS });
            return grant;
        },
        allows: (grant, device) => {
            const held = grants.get(grant);
            if (held === undefined) {
                return false;
            }
            if (held.until < now()) {
                grants.delete(grant);
                return false;
            }
            return held.device === device;
        },
        revoke: (grant) => void grants.delete(grant),
    };
};

export type DoorServices = Pick<Services, "conversations" | "hostHub" | "turnMounts" | "runGrants">;

// Undefined when the caller may act on `device`; otherwise the refusal to answer with.
export const refusalFor = (services: DoorServices, c: Context<AppEnv>, device: string): { status: 400 | 403; error: string } | undefined => {
    const grant = c.req.header("x-intentic-run-grant");
    if (grant !== undefined && grant !== "") {
        return services.runGrants.allows(grant, device)
            ? undefined
            : { status: 403, error: `this run may act on its own computer only, and only while it lasts; "${device}" is not it, or the run has ended` };
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
        args: z.array(z.string().max(4000)).max(100).optional(),
        env: z.record(z.string(), z.string().max(4000)).optional(),
        cwd: z.string().max(1000).optional(),
        name: z.string().max(100).optional(),
        isolated: z.boolean().optional(),
        network: z.boolean().optional(),
    })
    .strict();

const TunnelSchema = z.object({ port: z.int().min(1).max(65535), as: z.int().min(1).max(65535).optional() }).strict();

const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: `bad request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}` };
};

export const createDeviceDoorRoutes = (services: DoorServices & Pick<Services, "deviceTunnels">) => ({
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
        try {
            const { text, refused: toolRefused } = await callTool(services, device, "app_start", body.value, AbortSignal.timeout(60_000));
            return toolRefused ? c.json({ error: text }, 409) : c.json({ device, text });
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
