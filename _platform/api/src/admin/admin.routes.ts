import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { adminAttention } from "./admin-attention.js";
import { adminCosts } from "./admin-costs.js";
import { adminFunnel } from "./admin-funnel.js";
import { adminOverview } from "./admin-overview.js";
import { adminUserDetail } from "./admin-user.js";
import { adminUsers } from "./admin-users.js";

const os = implement(apiContract).$context<OrpcContext>();

/* The admin namespace's one rule, enforced by shape: every handler below opens with `audited`, which is
 * requireAdmin (the ADMIN_EMAILS gate, guards.ts) plus the audit line. The log is the operator's own
 * accountability record — admin reads are rare and each one names who asked for what, so "what did the
 * admin surface serve and to whom" is always answerable from the platform's ordinary logs. */
const audited = (context: OrpcContext, route: string) => {
    const admin = requireAdmin(context);
    context.logger.info({ admin: admin.email, route }, `admin api`);
    return admin;
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
        return adminAttention(context.prisma, context.config);
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
};
