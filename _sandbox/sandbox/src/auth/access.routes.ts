import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { bearerFrom, ForbiddenError } from "./auth.js";
import { ownerDenied } from "./owner-gates.js";

// What still holds a browser credential to this sandbox, and the three ways to act on it: mint a ticket, sign every
// browser out, or retire access for good.
// Beside the members routes, not in them: this is about what holds a credential, not who may access the sandbox.

export type AccessRoutesDeps = Pick<Services, "auth" | "wsTickets">;

export const createAccessRoutes = (services: AccessRoutesDeps) => ({
    // Mints the one-shot ticket a WebSocket upgrade redeems; this route rides the bearer middleware, so the credential
    // is presented in a header, not the query string.
    // Loopback mode has no identity to bind a ticket to and no gate on the upgrades either, so it 404s and the browser
    // connects without one.
    wsTicket: (c: Context<AppEnv>): Response => {
        const identity = c.get("identity");
        if (services.auth === undefined || identity === undefined) {
            return c.json({ error: "no verified identity to mint a ticket for" }, 404);
        }
        return c.json({ ticket: services.wsTickets.mint(identity) });
    },
    // Re-keys the session signer so every session minted for this sandbox stops verifying at once, including the
    // owner's own browser.
    // The owner's browser just re-establishes silently from its Google credential; loopback mode has nothing to rotate,
    // so it answers ok.
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
    // Account deletion: permanently refuses future browser authorization before rotating sessions and closing every
    // live transport; a surviving Google token can't re-establish.
    // Exempt from the bearer middleware so it stays repeatable after a partial attempt already disabled this daemon;
    // the one owner check allowed through is done here.
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
