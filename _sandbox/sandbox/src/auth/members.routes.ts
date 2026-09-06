import { type GrantedRole, GrantedRoleSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { ownershipDenied } from "./owner-gates.js";

/* The shared-access roster (/members): who besides the owner may reach this sandbox, and at what tier. Owner-
 * gated by OWNERSHIP rather than the maintainer-equivalent operating gate, because membership is the one thing
 * a revokable grant must not be able to change. Plain Hono routes before the oRPC catch-all. */

export type MembersRoutesDeps = Pick<Services, "auth" | "members" | "ownerEmail" | "wsTickets">;

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// A grant request's email + role, or undefined when either is absent/malformed. The role is required, a
// grant IS a role decision, and a default picked here would be a policy nobody chose.
const memberGrant = async (c: Context): Promise<{ email: string; role: GrantedRole } | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown; role?: unknown } | undefined;
    const role = GrantedRoleSchema.safeParse(body?.role);
    if (typeof body?.email !== "string" || !role.success) {
        return undefined;
    }
    return { email: body.email.toLowerCase(), role: role.data };
};

export const createMembersRoutes = (services: MembersRoutesDeps) => ({
    /** GET /members */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        /* THE OWNER RIDES ALONG, and the roster is the poorer without them: ownership is an identity fact
         * rather than a grant, so the members file has never held it, which left every surface built on this
         * answer unable to name the one person who is definitely allowed in. That was invisible until
         * credential gates needed an approver list — "only Bob may release this" is picked from the people
         * this route names, and the owner picking themselves was the obvious first case and the one that
         * could not be expressed. Undefined before first sign-in has bound anybody (loopback and test
         * daemons), which reads as a roster with no owner rather than an error. */
        const owner = await services.ownerEmail();
        return c.json({ members: await services.members.list(), ...(owner !== undefined ? { owner } : {}) });
    },
    /** POST /members */
    add: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const grant = await memberGrant(c);
        if (grant === undefined) {
            return c.json({ error: "email and role required" }, 400);
        }
        await services.members.add(grant.email, grant.role);
        // A role is frozen into an already-open socket/ticket. Close both so the next transport re-enters the
        // authorizer and picks up the new tier (especially a downgrade).
        services.auth?.connections.revoke(grant.email);
        services.wsTickets.revoke(grant.email);
        return c.json({ members: await services.members.list() });
    },
    /** DELETE /members */
    remove: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.remove(email);
        services.auth?.connections.revoke(email);
        services.wsTickets.revoke(email);
        return c.json({ members: await services.members.list() });
    },
    /** DELETE /members/self */
    removeSelf: async (c: Context<AppEnv>): Promise<Response> => {
        const identity = c.get("identity");
        if (identity === undefined) {
            return c.json({ error: "verified member required" }, 401);
        }
        if (identity.role === "owner") {
            return c.json({ error: "the owner must retire the sandbox instead" }, 400);
        }
        // Normalized, because the roster only ever holds lowercase (memberGrant/memberEmail above) while the
        // identity carries the claim as Google sent it: the raw form targets a row that cannot exist, so a
        // mixed-case member's "remove me" reported success and left them granted.
        await services.members.remove(identity.email.toLowerCase());
        services.auth?.connections.revoke(identity.email);
        services.wsTickets.revoke(identity.email);
        return c.json({ ok: true });
    },
});
