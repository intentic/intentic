import {
    type Environment,
    EnvironmentRebuildWhenIdleSchema,
    EnvironmentRemoveSchema,
    EnvironmentRuntimeDecisionSchema,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import type { RebuildWhenIdle } from "../hosts/rebuild-when-idle.js";
import { readEnvironmentContents } from "./contents.js";
import { approveEnvironment, decideRuntimeInstall, readEnvironment, rejectEnvironment, removeFromEnvironment } from "./environment.js";
import { clearVersionCache } from "./version-probe.js";

// The agent-proposed overlay Dockerfile (.intentic/config/environment.Dockerfile): members read it, only the owner
// approves (copies it to the approved file) or rejects (deletes the proposal). The rebuild itself runs outside the
// container, pinned to the approved hash, so approval here never mutates the running sandbox. Plain Hono routes, ahead
// of the oRPC catch-all.

// `waiter` is the one rebuild waiting for this sandbox's agents to be idle; every answer below carries it, so the card
// that asked, or any other page, sees it waiting, starting, or refused. Built by app.ts from the hosts' own verbs, since
// hosts reach environment and importing them here would close a cycle.
export const createEnvironmentRoutes = (services: Services, waiter: RebuildWhenIdle) => {
    const environmentNow = async (): Promise<Environment> => {
        const environment: Environment = { ...(await readEnvironment(services)), waitsForAgents: true };
        const wait = waiter.state();
        if (wait !== undefined) {
            environment.rebuildWhenIdle = wait;
        }
        return environment;
    };
    return {
        /** GET /environment */
        read: async (c: Context<AppEnv>): Promise<Response> => c.json(await environmentNow()),
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
            // allow(silent-catch): Unreadable JSON is refused by the required hash check below.
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
                    {
                        error: "the proposal must contain only RUN/ENV content, no FROM (the daemon owns the base image) and no intentic:runtime lines",
                    },
                    400,
                );
            }
            return c.json(await environmentNow());
        },
        /** POST /environment/reject */
        reject: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            await rejectEnvironment(services);
            return c.json(await environmentNow());
        },
        // Owner decision on one recurring install: `adopt` writes its draft immediately, bypassing the sweep's gates since
        // the owner asked; `dismiss` tombstones it and its auto-draft, `restore` undoes that. Owner-gated, like approve.
        runtimeInstall: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            // allow(silent-catch): Unreadable JSON is refused by the decision schema below.
            const body = EnvironmentRuntimeDecisionSchema.safeParse(await c.req.json().catch(() => undefined));
            if (!body.success) {
                return c.json({ error: "tool and decision required" }, 400);
            }
            if ((await decideRuntimeInstall(services, body.data)) === "unavailable") {
                return c.json({ error: "no runtime install by that name has a mechanical overlay step" }, 404);
            }
            return c.json(await environmentNow());
        },
        // Takes one tool out: its approved block (the overlay then waits for a rebuild), its pending draft, or both, and a
        // copy an agent's branch still carries does not bring it back. Owner-gated, like approve.
        remove: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            // allow(silent-catch): Unreadable JSON is refused by the removal schema below.
            const body = EnvironmentRemoveSchema.safeParse(await c.req.json().catch(() => undefined));
            if (!body.success) {
                return c.json({ error: "block required" }, 400);
            }
            if ((await removeFromEnvironment(services, body.data.block)) === "missing") {
                return c.json({ error: "nothing by that name is in the environment or waiting to join it" }, 404);
            }
            return c.json(await environmentNow());
        },
        // Rebuild once nothing a restart would cut is in flight, by the device named, as its Rebuild button would; at once when none is now.
        // The same floor as that button's door (the device routes).
        rebuildWhenIdle: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            // allow(silent-catch): Unreadable JSON is refused by the rebuild schema below.
            const body = EnvironmentRebuildWhenIdleSchema.safeParse(await c.req.json().catch(() => undefined));
            if (!body.success) {
                return c.json({ error: "host and hash required" }, 400);
            }
            if ((await waiter.ask(body.data)) === "unnamed") {
                return c.json({ error: "this sandbox has no name a device could rebuild it by" }, 409);
            }
            return c.json(await environmentNow());
        },
        /** DELETE /environment/rebuild-when-idle: withdraws a waiting rebuild, or dismisses a refused one. */
        cancelRebuildWhenIdle: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            if (waiter.cancel() === "started") {
                return c.json({ error: "the rebuild has already started on the device, and restarts this sandbox when it is built" }, 409);
            }
            return c.json(await environmentNow());
        },
    };
};
