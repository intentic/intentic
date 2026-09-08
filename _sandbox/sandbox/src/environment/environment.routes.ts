import { EnvironmentRuntimeDecisionSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { readEnvironmentContents } from "./contents.js";
import { approveEnvironment, decideRuntimeInstall, readEnvironment, rejectEnvironment } from "./environment.js";
import { clearVersionCache } from "./version-probe.js";

// The agent-proposed overlay Dockerfile (.intentic/config/environment.Dockerfile): members read it, only the owner
// approves (copies it to the approved file) or rejects (deletes the proposal). The rebuild itself runs outside the
// container, pinned to the approved hash, so approval here never mutates the running sandbox. Plain Hono routes, ahead
// of the oRPC catch-all.

export const createEnvironmentRoutes = (services: Services) => ({
    /** GET /environment */
    read: async (c: Context<AppEnv>): Promise<Response> => c.json(await readEnvironment(services)),
    // The same sandbox read as contents, versions read back from the tool, rather than the recipe; split out since
    // /environment is polled constantly and version probes would tax every tab. `refresh` avoids caching a mid-session
    // install as missing.
    contents: async (c: Context<AppEnv>): Promise<Response> => {
        if (c.req.query("refresh") !== undefined) {
            clearVersionCache();
            // Not awaited: the sweep persists its own snapshot and the watcher refetches when the answer lands.
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
    // Owner decision on one recurring install: `adopt` writes its draft immediately, bypassing the sweep's gates since
    // the owner asked; `dismiss` tombstones it and its auto-draft, `restore` undoes that. Owner-gated, like approve.
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
