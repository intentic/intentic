import { type GrantedRole, GrantedRoleSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { ownershipDenied } from "./owner-gates.js";

// The shared-access roster (/members): who besides the owner may reach this sandbox, and at what tier.
// Owner-gated by ownership rather than the maintainer-equivalent operating gate, since membership is the one thing a
// revokable grant must not change.

export type MembersRoutesDeps = Pick<Services, "auth" | "members" | "ownerEmail" | "wsTickets">;

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// A grant request's email + role, or undefined if either is missing or malformed.
// Role is required: a grant is a role decision, and a default here would be a policy nobody chose.
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
        // The owner rides along here since ownership is an identity fact the members file never holds; without it no
        // approver list could name the owner.
        // Undefined before first sign-in reads as a roster with no owner yet, not an error (loopback and test daemons).
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
        // A role is frozen into an open socket/ticket; closing both re-enters the authorizer with the new tier.
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
        // Normalized: the roster holds lowercase, but identity carries Google's claim as sent; raw form hits no row.
        await services.members.remove(identity.email.toLowerCase());
        services.auth?.connections.revoke(identity.email);
        services.wsTickets.revoke(identity.email);
        return c.json({ ok: true });
    },
});
