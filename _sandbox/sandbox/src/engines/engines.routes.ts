import { EngineChannelInputSchema, EngineRevertInputSchema, EngineUpdateInputSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { opt } from "../agent/run/opt.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { enginesView, revertEngine, setChannel, updateEngine } from "./engines.js";

// Which version of each agent engine this sandbox runs, and where it comes from. Mounted beside /environment and
// owner-only for the same reason: these writes install code every turn then runs. Update's version is optional; absent
// takes what the channel offers, naming one deliberately takes an unblessed version, the way past a floor the blessed
// list has not caught up with.

export type EnginesRoutesDeps = Pick<Services, "auth" | "workspace" | "logger">;

export const createEnginesRoutes = (services: EnginesRoutesDeps) => ({
    /** GET /engines */
    view: async (c: Context<AppEnv>): Promise<Response> => c.json(await enginesView(services)),
    /** POST /engines/channel */
    channel: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const parsed = EngineChannelInputSchema.safeParse(await c.req.json().catch(() => undefined));
        if (parsed.data === undefined) {
            return c.json({ error: "an engine id and a channel are required" }, 400);
        }
        const { id, kind, version } = parsed.data;
        try {
            await setChannel(services, id, { kind, ...opt("version", version) });
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : "the channel could not be set" }, 400);
        }
        // Same shape every write answers with: what happened, plus the whole view, never a patch to reconcile.
        return c.json({ applied: null, engines: await enginesView(services) });
    },
    /** POST /engines/update */
    update: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const parsed = EngineUpdateInputSchema.safeParse(await c.req.json().catch(() => undefined));
        if (parsed.data === undefined) {
            return c.json({ error: "an engine id is required" }, 400);
        }
        try {
            const applied = await updateEngine(services, parsed.data.id, {
                ...opt("version", parsed.data.version),
                ...opt("floor", parsed.data.floor),
            });
            // Nothing to do is a 200 with the view, not an error: a second tab's Update is a race, not a fault.
            return c.json({ applied: applied ?? null, engines: await enginesView(services) });
        } catch (error) {
            // Install itself refused (bad download, or a version that would not launch); reason comes from the store.
            return c.json({ error: error instanceof Error ? error.message : "the engine could not be installed" }, 502);
        }
    },
    /** POST /engines/revert */
    revert: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const parsed = EngineRevertInputSchema.safeParse(await c.req.json().catch(() => undefined));
        if (parsed.data === undefined) {
            return c.json({ error: "an engine id is required" }, 400);
        }
        const applied = await revertEngine(services, parsed.data.id);
        return c.json({ applied, engines: await enginesView(services) });
    },
});
