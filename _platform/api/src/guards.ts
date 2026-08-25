import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "./context.js";

// The session gate shared by every oRPC handler, resolves the caller or throws UNAUTHORIZED.
export const requireUser = (context: OrpcContext) => {
    if (!context.user) {
        throw new ORPCError(`UNAUTHORIZED`);
    }
    return context.user;
};

/* The operator gate for every /admin route: the caller's session, checked against the ADMIN_EMAILS
 * allowlist (config.ts `admin.emails`). Sign-in is Google-only, so the session email is Google-verified —
 * possession of the session IS proof of the address. Case-insensitive, whitespace-tolerant, and an empty
 * allowlist refuses everyone (the admin surface of a platform that never configured one does not exist).
 * FORBIDDEN rather than NOT_FOUND: the surface is public source code, hiding it buys nothing, and a
 * signed-in operator hitting a misconfigured deployment should read "not allowed", not "no such route". */
export const requireAdmin = (context: OrpcContext) => {
    const user = requireUser(context);
    const allowed = context.config.admin.emails
        .split(`,`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0);
    if (!allowed.includes(user.email.toLowerCase())) {
        throw new ORPCError(`FORBIDDEN`);
    }
    return user;
};

// Load a sandbox the caller owns, or 404, the gate for every owner-only route (tunnel/delete/sharing).
export const requireOwnedSandbox = async (context: OrpcContext, sandboxId: string) => {
    const user = requireUser(context);
    const sandbox = await context.prisma.sandbox.findFirst({ where: { id: sandboxId, ownerId: user.id } });
    if (!sandbox) {
        throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
    }
    return sandbox;
};
