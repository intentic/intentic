import { WorkspacePublishSchema } from "@intentic/sandbox-contract/state/definition";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { createDefinitions } from "./apply-definition.js";
import { DefinitionFormatError } from "./definition.js";
import { publishWorkspace, workspaceRemote, WorkspaceRemoteError } from "./workspace-repo.js";
import { defineRawRoutes } from "../http/raw-route-server.js";

// Outbound definition (sandbox.toml); definition.ts covers the bundle half. Owner-gated: derive and diff only read;
// publish creates a private repo on a connected git host and pushes /work to it.

const createDefinitionRoutes = (services: Services) => {
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
                // Owner-actionable failures (already published, no host, refused create, rejected push), not breakage.
                if (error instanceof WorkspaceRemoteError) {
                    return c.json({ error: error.message }, 409);
                }
                throw error;
            }
        },
    };
};

// The definition, outbound: `sandbox.toml` derived and diffed, and the workspace repo it names.
export const definitionRawRoutes = defineRawRoutes((services: Services) => {
    const definition = createDefinitionRoutes(services);
    return {
        "GET /definition": definition.derive,
        "POST /definition/diff": definition.diff,
        "GET /definition/workspace": definition.workspace,
        "POST /definition/workspace/publish": definition.publish,
    };
});
