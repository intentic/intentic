import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "./context.js";

// The session gate shared by every oRPC handler — resolves the caller or throws UNAUTHORIZED.
export const requireUser = (context: OrpcContext) => {
    if (!context.user) {
        throw new ORPCError(`UNAUTHORIZED`);
    }
    return context.user;
};

// Load a sandbox the caller owns, or 404 — the gate for every owner-only route (tunnel/delete/sharing).
export const requireOwnedSandbox = async (context: OrpcContext, sandboxId: string) => {
    const user = requireUser(context);
    const sandbox = await context.prisma.sandbox.findFirst({ where: { id: sandboxId, ownerId: user.id } });
    if (!sandbox) {
        throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
    }
    return sandbox;
};
