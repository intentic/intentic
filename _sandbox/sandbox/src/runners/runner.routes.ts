import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { emitDefinitionToml, settingsDefinition } from "../portability/definition.js";

/* The one owner route a runner has beyond its peer door (runner-peer.ts): the settings push.
 *
 * POST /system/runners/:id/definition/sync. Push this sandbox's settings onto one runner, the fix for the
 * drift lines its summary carries: the settings-only definition travels down the runner's own live link and
 * REPLACES the runner's settings (the runner contract says why replace). Owner-only like every other runner
 * mutation, and refused rather than queued when the runner is offline — a deferred settings push landing
 * hours later, after the owner changed their mind again, is drift manufactured by the fix. */
export const createRunnerDefinitionSyncRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        const client = services.runnerHub.client(id);
        if (client === undefined) {
            return c.json({ error: "that runner is offline — wake its machine, then sync again." }, 409);
        }
        const toml = emitDefinitionToml(await settingsDefinition(services));
        const report = await client.applyDefinition({ toml });
        // The runner now runs exactly what was sent; adopting it here clears the drift without a reconnect.
        // The tab that pushed the settings refetches on its own mutation; every OTHER open tab hears it here.
        const announced = services.runnerHub.state(id).announced;
        if (announced !== undefined) {
            services.runnerHub.announce(id, { ...announced, definitionToml: toml });
        }
        return c.json(report);
    };
