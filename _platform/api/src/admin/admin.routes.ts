import { apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { deleteUserAccount, liftUserHosted, stopHostedMachine, suspendUserHosted } from "./admin-actions.js";
import { adminAttention } from "./admin-attention.js";
import { adminCosts } from "./admin-costs.js";
import { adminFunnel } from "./admin-funnel.js";
import { adminOverview } from "./admin-overview.js";
import { adminTrends } from "./admin-trends.js";
import { adminUserDetail } from "./admin-user.js";
import { adminUsers } from "./admin-users.js";

const os = implement(apiContract).$context<OrpcContext>();

// Enforces the admin namespace's one rule by shape: every handler opens with `audited` (requireAdmin plus a log line
// naming who asked for what).
const audited = (context: OrpcContext, route: string) => {
    const admin = requireAdmin(context);
    context.logger.info({ admin: admin.email, route }, `admin api`);
    return admin;
};

// The mutation surface's deployment switch, off by default until the panel's bytes are a pinned install. Forbidden
// rather than 404: the caller is a verified admin.
const requireMutations = (context: OrpcContext) => {
    if (!context.config.admin.mutations) {
        throw new ORPCError(`FORBIDDEN`, { message: `admin mutations are disabled on this deployment (ADMIN_MUTATIONS)` });
    }
};

// The shared gate for every mutation but userDelete: admin + audit, the deployment switch, and a typed confirmation
// naming the target exactly.
const mutating = (context: OrpcContext, route: string, confirm: string, target: string) => {
    const admin = audited(context, route);
    requireMutations(context);
    if (confirm.trim() !== target) {
        throw new ORPCError(`BAD_REQUEST`, { message: `confirmation must repeat “${target}” exactly` });
    }
    return admin;
};

// The gate for a mutation addressed to an ACCOUNT: admin + audit, the deployment switch, the row, and the strongest
// confirmation on the surface, the account's email retyped, case-insensitively but in full.
const confirmedAccount = async (context: OrpcContext, route: string, input: { userId: string; confirmEmail: string }) => {
    const admin = audited(context, route);
    requireMutations(context);
    const target = await context.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true } });
    if (target === null) {
        throw new ORPCError(`NOT_FOUND`, { message: `no account with that id` });
    }
    if (input.confirmEmail.trim().toLowerCase() !== target.email.toLowerCase()) {
        throw new ORPCError(`BAD_REQUEST`, { message: `confirmation must repeat the account's email exactly` });
    }
    return { admin, target };
};

export const adminRoutes = {
    overview: os.admin.overview.handler(async ({ context }) => {
        audited(context, `admin.overview`);
        return adminOverview(context.prisma, context.config);
    }),
    funnel: os.admin.funnel.handler(async ({ context }) => {
        audited(context, `admin.funnel`);
        return adminFunnel(context.prisma);
    }),
    attention: os.admin.attention.handler(async ({ context }) => {
        audited(context, `admin.attention`);
        return adminAttention(context.prisma);
    }),
    costs: os.admin.costs.handler(async ({ context }) => {
        audited(context, `admin.costs`);
        return adminCosts(context.prisma, context.config);
    }),
    users: os.admin.users.handler(async ({ context, input }) => {
        audited(context, `admin.users`);
        return adminUsers(context.prisma, input);
    }),
    user: os.admin.user.handler(async ({ context, input }) => {
        audited(context, `admin.user`);
        const detail = await adminUserDetail(context.prisma, input.idOrEmail);
        if (detail === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `no account with that id or email` });
        }
        return detail;
    }),
    trends: os.admin.trends.handler(async ({ context }) => {
        audited(context, `admin.trends`);
        return adminTrends(context.prisma);
    }),

    machineStop: os.admin.machineStop.handler(async ({ context, input }) => {
        mutating(context, `admin.machineStop`, input.confirm, input.sandboxId);
        return stopHostedMachine(context.prisma, context.config, input.sandboxId);
    }),
    userDelete: os.admin.userDelete.handler(async ({ context, input }) => {
        const { admin, target } = await confirmedAccount(context, `admin.userDelete`, input);
        // Erasing the operator's own account from the panel is more likely a mis-paste than an intention.
        if (target.email.toLowerCase() === admin.email.toLowerCase()) {
            throw new ORPCError(`BAD_REQUEST`, { message: `refusing to delete the signed-in admin's own account from here; use Settings` });
        }
        context.logger.warn({ admin: admin.email, target: target.email }, `admin erasure`);
        return deleteUserAccount(context.prisma, context.config, context.logger, target.id);
    }),
    userSuspend: os.admin.userSuspend.handler(async ({ context, input }) => {
        const { admin, target } = await confirmedAccount(context, `admin.userSuspend`, input);
        if (target.email.toLowerCase() === admin.email.toLowerCase()) {
            throw new ORPCError(`BAD_REQUEST`, { message: `refusing to suspend the signed-in admin's own account` });
        }
        context.logger.warn({ admin: admin.email, target: target.email, reason: input.reason }, `admin suspension`);
        return suspendUserHosted(context.prisma, context.config, context.logger, target, input.reason.trim());
    }),
    userUnsuspend: os.admin.userUnsuspend.handler(async ({ context, input }) => {
        const { admin, target } = await confirmedAccount(context, `admin.userUnsuspend`, input);
        context.logger.warn({ admin: admin.email, target: target.email }, `admin suspension lifted`);
        return liftUserHosted(context.prisma, context.logger, target);
    }),
};
