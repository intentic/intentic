import { EngineChannelInputSchema, EngineRevertInputSchema, EngineUpdateInputSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { opt } from "../agent/run/opt.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { enginesView, revertEngine, setChannel, updateEngine } from "./engines.js";

/* THE AGENT ENGINES: which version of Claude Code, codex, @cursor/sdk, opencode and the translator this
 * sandbox runs, and where each of those versions comes from (engines/engines.ts).
 *
 * Mounted beside /environment because it answers the same owner question — what is installed here — and
 * because these four writes are the ones that end the era of "wait for an image". Members read; only the owner
 * changes a channel, takes a version or reverts one, for the reason /environment/approve is owner-only:
 * this installs code that every turn in this sandbox then runs.
 *
 * Update takes an optional version. Absent means what the channel offers, which is the row's button.
 * Naming one is deliberate and takes a version nobody has blessed — the way past an upstream floor the
 * blessed list has not caught up with, which is a decision a person makes with the reason in front of them. */

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
        // The same shape all three writes answer with: what happened (nothing, for a channel that needs a
        // download first) and the whole view, so a card never has to reconcile a patch with what it was drawing.
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
            // Nothing to do is a 200 with the view, not an error: two tabs pressing Update on the same row is
            // an ordinary race, and the second one is right about the state it is looking at.
            return c.json({ applied: applied ?? null, engines: await enginesView(services) });
        } catch (error) {
            // The install itself refused (a bad download, a version that would not launch). The reason is the
            // one the store recorded, and the row carries the quarantine that goes with it.
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
