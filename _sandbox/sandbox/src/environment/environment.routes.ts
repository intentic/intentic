import { EnvironmentRuntimeDecisionSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { readEnvironmentContents } from "./contents.js";
import { approveEnvironment, decideRuntimeInstall, readEnvironment, rejectEnvironment } from "./environment.js";
import { clearVersionCache } from "./version-probe.js";

/* The agent-proposed overlay Dockerfile (.intentic/config/environment.Dockerfile). Members see the state; only
 * the owner approves (copying it to the approved file) or rejects (deleting the proposal). The rebuild itself
 * runs OUTSIDE the container, recreate.sh locally, the workspace provider on a server, pinned to the approved
 * hash, so approval here never mutates the running sandbox. Plain Hono routes before the oRPC catch-all. */

export const createEnvironmentRoutes = (services: Services) => ({
    /** GET /environment */
    read: async (c: Context<AppEnv>): Promise<Response> => c.json(await readEnvironment(services)),
    /* GET /environment/contents. The same sandbox read as CONTENTS rather than as a recipe, what it has, with
     * each tool's version read back from the tool. A route of its own because it costs process spawns:
     * /environment above is polled by the shell's rebuild banner and re-fetched on every write under
     * .intentic/environment., and making that pay for forty version checks would be a tax on the whole app for
     * one tab. `refresh` re-probes, which is what the card's refresh button is for, a tool installed
     * mid-session is otherwise cached as missing. */
    contents: async (c: Context<AppEnv>): Promise<Response> => {
        if (c.req.query("refresh") !== undefined) {
            clearVersionCache();
            // The drift half of "it says X but I just changed it": re-probe now, not at the next idle tick.
            // Not awaited — the sweep persists its snapshot and the watcher invalidates `environment`, so the
            // card refetches when the answer lands rather than holding this response on a find walk.
            void services.driftSweep.refresh();
        }
        return c.json(await readEnvironmentContents(services));
    },
    /** POST /environment/approve */
    approve: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { hash?: unknown } | undefined;
        const hash = typeof body?.hash === "string" ? body.hash : undefined;
        if (hash === undefined) {
            return c.json({ error: "hash required" }, 400);
        }
        const failure = await approveEnvironment(services, hash);
        if (failure === "missing") {
            return c.json({ error: "no proposal to approve" }, 404);
        }
        if (failure === "mismatch") {
            return c.json({ error: "the proposal changed since it was reviewed, refresh and re-approve" }, 409);
        }
        if (failure === "invalid") {
            return c.json(
                { error: "the proposal must contain only RUN/ENV content, no FROM (the daemon owns the base image) and no intentic:runtime lines" },
                400,
            );
        }
        return c.json(await readEnvironment(services));
    },
    /** POST /environment/reject */
    reject: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        await rejectEnvironment(services);
        return c.json(await readEnvironment(services));
    },
    /* POST /environment/runtime-install. The owner answering ONE line of the runtime-install list, which until
     * now had no answer at all: rejecting a whole proposal was the only route to a tombstone, so a recurring
     * install nobody wanted baked went on being reported forever. `adopt` writes the tool's overlay draft on
     * the spot (the sweep's recurrence and corroboration gates exist to justify a draft nobody asked for; this
     * owner asked), `dismiss` tombstones it and takes its auto-draft with it, `restore` undoes that.
     * Owner-gated for the reason approve is: it decides what gets built into the image every turn then runs
     * on. */
    runtimeInstall: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const body = EnvironmentRuntimeDecisionSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "tool and decision required" }, 400);
        }
        if ((await decideRuntimeInstall(services, body.data)) === "unavailable") {
            return c.json({ error: "no runtime install by that name has a mechanical overlay step" }, 404);
        }
        return c.json(await readEnvironment(services));
    },
});
