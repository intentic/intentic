import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "./context.js";
import { hasGoogleAccount } from "./sign-in.js";

// The session gate shared by every oRPC handler, resolves the caller or throws UNAUTHORIZED.
export const requireUser = (context: OrpcContext) => {
    if (!context.user) {
        throw new ORPCError(`UNAUTHORIZED`);
    }
    return context.user;
};

/* The operator gate for every /admin route: the caller's session, checked against the ADMIN_EMAILS allowlist (config.ts
 * `admin.emails`), for an address proven the way the deployment asks (`admin.signIn`). The panel reads every account, so
 * by default an address on the list is an admin only with a Google account linked to it: an emailed code alone would
 * make the inbox the whole key. (2026-10-12) Came with email sign-in, which made an address claimable without Google. */
export const requireAdmin = async (context: OrpcContext) => {
    const user = requireUser(context);
    const allowed = context.config.admin.emails
        .split(`,`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0);
    if (!allowed.includes(user.email.toLowerCase())) {
        throw new ORPCError(`FORBIDDEN`);
    }
    if (!user.emailVerified) {
        throw new ORPCError(`FORBIDDEN`, { message: `an admin's address must be confirmed first` });
    }
    // Anything but an explicit `any` asks for Google, so a config that never said fails closed.
    if (context.config.admin.signIn !== `any` && !(await hasGoogleAccount(context.prisma, user.id))) {
        throw new ORPCError(`FORBIDDEN`, { message: `admin access needs a Google account linked to this one (ADMIN_SIGN_IN)` });
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
