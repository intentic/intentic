import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { poolEnabled } from "../pool/pool-membership.js";
import { retryPayout } from "../pool/pool-payout.js";
import { stripeGateway } from "../pool/pool-stripe.js";
import { deleteUserAccount, reinstateService, stopHostedMachine, suspendService } from "./admin-actions.js";
import { adminAttention } from "./admin-attention.js";
import { adminCosts } from "./admin-costs.js";
import { adminFunnel } from "./admin-funnel.js";
import { adminMarket } from "./admin-market.js";
import { adminOverview } from "./admin-overview.js";
import { adminTrends } from "./admin-trends.js";
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

// The mutation surface's deployment switch: off (the default) until the panel's bytes are a pinned install,
// per the trust note in the extension's README. FORBIDDEN rather than 404 — the caller is a verified admin
// reading why their click did nothing, and the honest answer is "this deployment has mutations off".
const requireMutations = (context: OrpcContext) => {
    if (!context.config.admin.mutations) {
        throw new ORPCError(`FORBIDDEN`, { message: `admin mutations are disabled on this deployment (ADMIN_MUTATIONS)` });
    }
};

/* The shared gate for every mutation but userDelete (whose confirmation is the email, checked in its own
 * handler): admin + audit, the deployment switch, and the typed confirmation naming the target exactly.
 * A mistyped confirmation is a 400 the panel shows verbatim — the retype-it pattern, not a warning. */
const mutating = (context: OrpcContext, route: string, confirm: string, target: string) => {
    const admin = audited(context, route);
    requireMutations(context);
    if (confirm.trim() !== target) {
        throw new ORPCError(`BAD_REQUEST`, { message: `confirmation must repeat “${target}” exactly` });
    }
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
    market: os.admin.market.handler(async ({ context }) => {
        audited(context, `admin.market`);
        return adminMarket(context.prisma, context.config);
    }),
    trends: os.admin.trends.handler(async ({ context }) => {
        audited(context, `admin.trends`);
        return adminTrends(context.prisma);
    }),

    serviceSuspend: os.admin.serviceSuspend.handler(async ({ context, input }) => {
        mutating(context, `admin.serviceSuspend`, input.confirm, input.slug);
        return suspendService(context.prisma, input.slug, input.reason);
    }),
    serviceReinstate: os.admin.serviceReinstate.handler(async ({ context, input }) => {
        mutating(context, `admin.serviceReinstate`, input.confirm, input.slug);
        return reinstateService(context.prisma, input.slug);
    }),
    payoutRetry: os.admin.payoutRetry.handler(async ({ context, input }) => {
        mutating(context, `admin.payoutRetry`, input.confirm, input.payoutId);
        if (!poolEnabled(context.config)) {
            return { ok: false, message: `The creator pool is not configured on this platform; there is no Stripe to retry against.` };
        }
        const outcome = await retryPayout(
            { prisma: context.prisma, config: context.config, gateway: stripeGateway(context.config.pool.stripeSecretKey) },
            input.payoutId,
        );
        return { ok: outcome.paid, message: outcome.message };
    }),
    machineStop: os.admin.machineStop.handler(async ({ context, input }) => {
        mutating(context, `admin.machineStop`, input.confirm, input.sandboxId);
        return stopHostedMachine(context.prisma, context.config, input.sandboxId);
    }),
    userDelete: os.admin.userDelete.handler(async ({ context, input }) => {
        const admin = audited(context, `admin.userDelete`);
        requireMutations(context);
        const target = await context.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true } });
        if (target === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `no account with that id` });
        }
        // The strongest confirmation on the surface: the account's email, retyped. Case-insensitive —
        // an address's case is presentation — but nothing less than the whole address.
        if (input.confirmEmail.trim().toLowerCase() !== target.email.toLowerCase()) {
            throw new ORPCError(`BAD_REQUEST`, { message: `confirmation must repeat the account's email exactly` });
        }
        // Erasing the operator's own account from the panel is more likely a mis-paste than an intention.
        if (target.email.toLowerCase() === admin.email.toLowerCase()) {
            throw new ORPCError(`BAD_REQUEST`, { message: `refusing to delete the signed-in admin's own account from here; use Settings` });
        }
        context.logger.warn({ admin: admin.email, target: target.email }, `admin erasure`);
        return deleteUserAccount(context.prisma, context.config, context.logger, target.id);
    }),
};
