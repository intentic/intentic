import { WorkspacePublishSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { createDefinitions } from "./apply-definition.js";
import { DefinitionFormatError } from "./definition.js";
import { publishWorkspace, workspaceRemote, WorkspaceRemoteError } from "./workspace-repo.js";

/* THE DEFINITION, OUTBOUND: the declarable shape of this sandbox as `sandbox.toml`, the reference half of
 * what a bundle carries whole (portability/definition.ts). Owner-only like the bundle export beside it: the
 * derivation reads every connection's shape and every repo's remote.
 *
 * TWO ROUTES, BOTH READS. Deriving the document and comparing against one write nothing; APPLYING one is an
 * arrival, and lives with the other three arrivals (arrival.routes.ts) rather than in a plan/apply/report
 * trio of its own that did the same job as the bundle's, differently.
 *
 * THE WORKSPACE REPO is the half of the definition a document cannot supply for itself: `[workspace]` names a
 * remote, and nothing can name one that does not exist. A read for the card's first render, and an
 * owner-gated write that creates a PRIVATE repo on a connected git host and pushes /work to it. Its own
 * route rather than a side effect of the export, because publishing is outward and deriving is read-only
 * (portability/workspace-repo.ts argues both halves). */

export const createDefinitionRoutes = (services: Services) => {
    const definitions = createDefinitions(services);
    return {
        /** GET /definition */
        derive: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            return c.json(await definitions.derive());
        },
        /** POST /definition/diff */
        diff: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            try {
                return c.json(await definitions.diff(await c.req.text()));
            } catch (error) {
                if (error instanceof DefinitionFormatError) {
                    return c.json({ error: error.message }, 400);
                }
                throw error;
            }
        },
        /** GET /definition/workspace */
        workspace: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            return c.json(await workspaceRemote(services));
        },
        /** POST /definition/workspace/publish */
        publish: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const parsed = WorkspacePublishSchema.safeParse((await c.req.json().catch(() => undefined)) ?? {});
            if (!parsed.success) {
                return c.json({ error: "expected { remote?, name?, owner? }" }, 400);
            }
            try {
                return c.json(await publishWorkspace(services, parsed.data));
            } catch (error) {
                // Already published, no connected host, a refused create, a rejected push: all things the owner
                // can act on, none of them breakage.
                if (error instanceof WorkspaceRemoteError) {
                    return c.json({ error: error.message }, 409);
                }
                throw error;
            }
        },
    };
};
