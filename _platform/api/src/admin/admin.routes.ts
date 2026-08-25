import { apiContract } from "@intentic-app/api-contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { adminOverview } from "./admin-overview.js";
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
        return adminOverview(context.prisma);
    }),
    users: os.admin.users.handler(async ({ context, input }) => {
        audited(context, `admin.users`);
        return adminUsers(context.prisma, input);
    }),
};
