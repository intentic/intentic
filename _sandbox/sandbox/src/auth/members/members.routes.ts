import { type GrantedRole, GrantedRoleSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { z } from "zod";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { type PersonaReachDeps, reachableCards } from "../../personas/persona-reach.js";
import { ownershipDenied } from "../owner-gates.js";

// The shared-access roster (/members): who besides the owner may reach this sandbox, and at what tier.
// Owner-gated by ownership rather than the maintainer-equivalent operating gate, since membership is the one thing a
// revokable grant must not change.

export type MembersRoutesDeps = Pick<Services, "auth" | "members" | "ownerEmail" | "wsTickets" | "personas" | "areas">;

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// A grant request's email + role + the areas it is fenced to, or undefined if any is missing or malformed.
// Role is required: a grant is a role decision, and a default here would be a policy nobody chose. Areas are
// optional, and their absence is the whole workspace — which is also every assistant, since which cards a person may
// wear is read off their fence (personas/persona-reach.ts) rather than listed per person.
const GrantBodySchema = z.object({
    email: z.string(),
    role: GrantedRoleSchema,
    areas: z.array(z.string().min(1)).max(20).optional(),
});

const memberGrant = async (c: Context): Promise<{ email: string; role: GrantedRole; areas?: readonly string[] } | undefined> => {
    const body = GrantBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
        return undefined;
    }
    const { email, role, areas } = body.data;
    return { email: email.toLowerCase(), role, ...(areas !== undefined ? { areas } : {}) };
};

// The two tiers whose fence IS the tier, refused unfenced: a writer's areas are the folders it may change, a desk's
// are the assistants it speaks through. For each, an absent area list resolves to the whole workspace — every file,
// every card — which is not a narrower grant of that tier but a different one nobody chose.
const fenceRequired = (grant: { role: GrantedRole; areas?: readonly string[] }): string | undefined => {
    if ((grant.areas?.length ?? 0) > 0) {
        return undefined;
    }
    if (grant.role === "writer") {
        return "a writer needs at least one area to write in";
    }
    return grant.role === "desk" ? "a desk needs at least one area: the assistants that work there are the ones it speaks through" : undefined;
};

// Why a fence cannot be written, or undefined when it can. Every area named exists, since a row pointing at an area
// nobody wrote resolves to a fence admitting nothing, and somebody would have to guess whether that was intended.
// A maintainer is not fenceable: the tier carries the owner's operating authority, reads every credential and drives
// every conversation, so a folder fence over it would be a line on a screen rather than a boundary.
const areaRefusal = async (services: Pick<Services, "areas">, grant: { role: GrantedRole; areas?: readonly string[] }): Promise<string | undefined> => {
    if (grant.areas === undefined) {
        return undefined;
    }
    if (grant.role === "maintainer") {
        return "a maintainer holds the owner's operating authority and cannot be fenced to part of the workspace";
    }
    const known = new Set((await services.areas.list()).map((area) => area.id));
    const missing = grant.areas.filter((id) => !known.has(id));
    return missing.length === 0 ? undefined : `no such area: ${missing.join(", ")}`;
};

// Why a desk's fence cannot be granted even though its areas exist: no card works in the folders it names. A desk
// reaches nothing but its assistants, so such a grant would sign somebody in to a chat that answers nothing.
// Checked only for a desk: every other tier has business in a workspace with no card homed in its folders.
const deskReachRefusal = async (services: PersonaReachDeps, grant: { role: GrantedRole; areas?: readonly string[] }): Promise<string | undefined> => {
    if (grant.role !== "desk") {
        return undefined;
    }
    const reached = await reachableCards(services, grant.areas);
    return reached.length > 0
        ? undefined
        : "no assistant works in those areas, so a desk fenced to them would have nobody to talk to; give an assistant a starting folder inside one, or fence the desk to an area that already has one";
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
        // The free refusal first, then the two that read a manifest; reach last, since it needs both of them.
        const refusal = fenceRequired(grant) ?? (await areaRefusal(services, grant)) ?? (await deskReachRefusal(services, grant));
        if (refusal !== undefined) {
            return c.json({ error: refusal }, 400);
        }
        await services.members.add(grant.email, grant);
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
