import { holdsRight, MANAGE_RIGHTS, type ManageRight } from "@intentic/sandbox-contract/schemas/members";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "./context.js";
import { storedGrant } from "./invite/invites.js";
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

// Load a sandbox the caller owns, or 404, the gate for every owner-only route (tunnel/delete); sharing is
// `requireRosterManager`.
export const requireOwnedSandbox = async (context: OrpcContext, sandboxId: string) => {
    const user = requireUser(context);
    const sandbox = await context.prisma.sandbox.findFirst({ where: { id: sandboxId, ownerId: user.id } });
    if (!sandbox) {
        throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
    }
    return sandbox;
};

// Who is changing a sandbox's access roster, as sandbox-contract `peopleChangeRefusal` reads them.
export interface RosterManager {
    readonly email: string;
    readonly role: MemberRole;
    readonly manages: readonly ManageRight[];
}

/* Load a sandbox whose access roster the caller may manage, or 404 as `requireOwnedSandbox` does, so a sandbox they may
 * not manage reads the same as one that does not exist. That is its owner, or a person who accepted an invite to it and
 * holds Full access (the maintainer tier) or People & access (`people` in the row's `manages`). The row is the platform's
 * mirror of the daemon's grant. `manager` is what bounds the change each route then makes, through `peopleChangeRefusal`:
 * People & access alone never grants or touches Full access, never changes its holder's own row, and hands out only the
 * rights its holder has. (2026-10-29) Came with letting people besides the owner manage access. */
export const requireRosterManager = async (context: OrpcContext, sandboxId: string) => {
    const user = requireUser(context);
    const email = user.email.toLowerCase();
    const sandbox = await context.prisma.sandbox.findUnique({ where: { id: sandboxId } });
    if (sandbox?.ownerId === user.id) {
        return { sandbox, manager: { email, role: `owner`, manages: MANAGE_RIGHTS } satisfies RosterManager };
    }
    if (sandbox) {
        const member = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (member?.acceptedAt) {
            const manager: RosterManager = { email, ...storedGrant(member) };
            if (holdsRight(manager, `people`)) {
                return { sandbox, manager };
            }
        }
    }
    throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
};
