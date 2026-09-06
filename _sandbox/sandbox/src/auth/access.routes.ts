import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { bearerFrom, ForbiddenError } from "./auth.js";
import { ownerDenied } from "./owner-gates.js";

/* What is still holding a BROWSER credential to this sandbox, and the three ways to act on it: mint the
 * one-shot ticket a WebSocket upgrade redeems, sign every browser out, and retire browser access for good.
 * Beside the members routes rather than in them because none of this is about who may access the sandbox;
 * it is about what is still holding a credential to it, which is the question a lost laptop actually asks. */

export type AccessRoutesDeps = Pick<Services, "auth" | "wsTickets">;

export const createAccessRoutes = (services: AccessRoutesDeps) => ({
    /* POST /system/ws-ticket. Mint the one-shot ticket the WebSocket upgrades redeem. This route is ordinary
     * HTTP, so it rides the bearer middleware like everything else, which is the entire trick: the credential
     * is presented in a header here, and what travels in the upgrade's query string is a value that is
     * worthless the moment it is used. Identity comes from the middleware, never the body.
     *
     * Loopback mode has no identity to bind a ticket to and no gate on the upgrades either, so it 404s and the
     * browser connects without one. */
    wsTicket: (c: Context<AppEnv>): Response => {
        const identity = c.get("identity");
        if (services.auth === undefined || identity === undefined) {
            return c.json({ error: "no verified identity to mint a ticket for" }, 404);
        }
        return c.json({ ticket: services.wsTickets.mint(identity) });
    },
    /* POST /system/sessions/revoke. Sign out every browser: re-key the session signer, so all sessions minted
     * for this sandbox stop verifying at once (auth/session.ts). Owner-only, and the owner's OWN browser is
     * included, it 401s on its next call and silently re-establishes from the Google credential it already
     * holds, which is what makes this safe to offer as a button rather than a support procedure. Loopback
     * mode has no sessions to rotate and no owner to check, so it answers ok without doing anything. */
    revokeSessions: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        await services.auth?.rotateSessions();
        services.auth?.connections.revoke();
        services.wsTickets.revoke();
        return c.json({ ok: true });
    },
    // POST /system/access/disable. Account deletion, stronger than sign-out-everywhere: permanently refuse
    // future browser authorization before rotating sessions and closing every live transport. A surviving
    // Google proof/connect token can no longer re-establish. Local/control credentials remain available for
    // machine-owner cleanup. Exempt from the bearer middleware (app.ts) because it must be repeatable after a
    // partial attempt already disabled this daemon; the one owner check allowed through the permanent
    // retirement marker is performed here.
    disable: async (c: Context<AppEnv>): Promise<Response> => {
        if (services.auth !== undefined) {
            try {
                await services.auth.authorizeRetirement(bearerFrom(c.req.header("authorization")));
            } catch (error) {
                return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
            }
        }
        await services.auth?.disableBrowserAccess();
        await services.auth?.rotateSessions();
        services.auth?.connections.revoke();
        services.wsTickets.revoke();
        return c.json({ ok: true });
    },
});
