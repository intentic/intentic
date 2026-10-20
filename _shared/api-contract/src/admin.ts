import { z } from "zod";
import { BootReportSchema, SetupReportSchema } from "./ingress/ingress-schemas.js";
import { AnnounceRefusalSchema } from "./schemas.js";

// Operator's read of the platform (ADMIN_EMAILS-gated); an aggregate or directory row, never a credential.
// Read-only: this surface proves the authorization rail, mutations arrive later behind the same guard.

// The platform at a glance.
// `activeDaemons` counts sandboxes announced within five minutes, the wizard's own "connected" reading.
export const AdminOverviewSchema = z.object({
    users: z.number(),
    sandboxes: z.number(),
    activeDaemons: z.number(),
    // Sandboxes announced within 24h/7d/30d; lastSeenAt is an announce, so a long-running box reads as active.
    activeSandboxes: z.object({ day: z.number(), week: z.number(), month: z.number() }),
    // Stripe's own words for the plan book; `mrrUsd` is active x the hosted price, display only, never accounting.
    plans: z.object({
        active: z.number(),
        trialing: z.number(),
        pastDue: z.number(),
        canceled30d: z.number(),
        mrrUsd: z.number(),
    }),
    hostedMachines: z.number(),
    // Which optional lanes this deployment runs, as a config sanity card; booleans only, never the secrets.
    lanes: z.object({
        trial: z.boolean(),
        hostedPlan: z.boolean(),
        hosted: z.boolean(),
        wallet: z.boolean(),
        push: z.boolean(),
    }),
    // Whether ADMIN_MUTATIONS is on, for rendering action buttons; the server re-checks it on every mutation.
    mutationsEnabled: z.boolean(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

// The activation funnel: distinct accounts, each stage a superset of the next, so conversion is a subtraction.
//   accounts every user row
//   withSandbox created at least one sandbox
//   setupEngaged a setup started somewhere (code claimed, hosted machine, or a daemon announced)
//   connected a daemon has ever announced
//   activeLast7 announced within the last seven days
// `signupSeries` is per-UTC-day counts, oldest first, zero-filled.
export const AdminFunnelSchema = z.object({
    signups: z.object({ today: z.number(), last7: z.number(), last30: z.number(), total: z.number() }),
    signupSeries: z.array(z.object({ day: z.string(), count: z.number() })),
    funnel: z.object({
        accounts: z.number(),
        withSandbox: z.number(),
        setupEngaged: z.number(),
        connected: z.number(),
        activeLast7: z.number(),
    }),
    // Sign-up to first announce, over accounts that activated in the last 30 days; null if none did.
    activation: z.object({ medianHours: z.number(), count: z.number() }).nullable(),
});
export type AdminFunnel = z.infer<typeof AdminFunnelSchema>;

// One row of "this needs a human"; composed server-side so the vocabulary lives in one place.
// `kind` and the anchor ids are for grouping and drill-down, never for the UI to re-derive the words.
export const AdminAttentionItemSchema = z.object({
    kind: z.enum([
        `stuck-setup`,
        `announce-refusal`,
        `unreachable-sandbox`,
        `plan-past-due`,
        `pool-claim-lingering`,
        `pool-build-stale`,
        // The abuse watch struck a machine this week, and an account whose hosted lane is off (hosted-abuse.ts).
        `hosted-strike`,
        `hosted-suspended`,
    ]),
    severity: z.enum([`danger`, `warning`]),
    title: z.string(),
    detail: z.string().optional(),
    // The relevant moment (ISO): setup claimed, plan's last webhook, or the claim's last move.
    at: z.iso.datetime().optional(),
    // Drill-down anchors, present where they apply.
    email: z.email().optional(),
    sandboxId: z.string().optional(),
});
export type AdminAttentionItem = z.infer<typeof AdminAttentionItemSchema>;

// Ordered most-severe first, then newest; `truncated` means a category hit its cap, not a small problem.
export const AdminAttentionSchema = z.object({
    items: z.array(AdminAttentionItemSchema),
    truncated: z.boolean(),
});
export type AdminAttention = z.infer<typeof AdminAttentionSchema>;

// The bills before the invoice: the two places real money is spent on users' behalf.
// Config knobs ride along, so every figure renders against the promise it's spent under.
export const AdminCostsSchema = z.object({
    hosted: z.object({
        machines: z.number(),
        // Machines with an open wokeAt: awake now, or stopped with the stretch not yet counted.
        awakeOrUncounted: z.number(),
        idleWarned: z.number(),
        // Awake minutes billed this calendar month, and the per-owner free ceiling (0 = uncapped).
        monthMinutes: z.number(),
        monthlyHoursCap: z.number(),
        topOwners: z.array(z.object({ email: z.email(), minutes: z.number() })),
        /* WHAT EACH RUNG IS ACTUALLY COSTING, which is the only thing that can say whether its price is right.
         * `minutes` is this month's awake time on machines currently on that rung; `flyUsd` prices it at the
         * ladder's own published hourly rate plus the disks standing under it, whether awake or not. */
        byTier: z.array(
            z.object({
                tier: z.string(),
                machines: z.number(),
                minutes: z.number(),
                flyUsd: z.number(),
                // What the rung charges a month, times the machines on it; 0 for the free rung.
                priceUsd: z.number(),
            }),
        ),
        pool: z.array(
            z.object({
                region: z.string(),
                building: z.number(),
                ready: z.number(),
                claimed: z.number(),
                // Machines pulled on an image no longer configured; a rising count means the reconcile isn't
                // rebuilding.
                staleImage: z.number(),
            }),
        ),
        poolSize: z.number(),
        image: z.string(),
    }),
    trial: z.object({
        enabled: z.boolean(),
        dailyMessages: z.number(),
        messagesToday: z.number(),
        usersToday: z.number(),
        messages7d: z.number(),
        users7d: z.number(),
        // Which real model served each account's latest trial message over 7 days, stated as accounts, not messages.
        models: z.array(z.object({ model: z.string(), accounts: z.number() })),
    }),
});
export type AdminCosts = z.infer<typeof AdminCostsSchema>;

// The support page: one account, everything operational, so "it doesn't work" is answerable without psql.
// Operational rows and aggregates only, no credentials; sessions carry ip/userAgent for "is this sign-in you".
export const AdminUserSandboxSchema = z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime().nullable(),
    daemonUrl: z.string().nullable(),
    setupClaimedAt: z.iso.datetime().nullable(),
    setupReport: SetupReportSchema.nullable(),
    bootReport: BootReportSchema.nullable(),
    announceRefusal: AnnounceRefusalSchema.nullable(),
    hosted: z
        .object({
            region: z.string(),
            appName: z.string(),
            wokeAt: z.iso.datetime().nullable(),
            idleWarnedAt: z.iso.datetime().nullable(),
        })
        .nullable(),
    members: z.array(z.object({ email: z.email(), role: z.string(), accepted: z.boolean() })),
});

export const AdminUserDetailSchema = z.object({
    user: z.object({
        id: z.string(),
        email: z.email(),
        name: z.string(),
        image: z.string().nullable(),
        createdAt: z.iso.datetime(),
        termsVersion: z.string().nullable(),
    }),
    sessions: z.array(
        z.object({
            createdAt: z.iso.datetime(),
            expiresAt: z.iso.datetime(),
            ipAddress: z.string().nullable(),
            userAgent: z.string().nullable(),
        }),
    ),
    // Auth providers on the account ("google", …), and "email" for one that signs in with a mailed code.
    providers: z.array(z.string()),
    plan: z.object({ status: z.string(), currentPeriodEnd: z.iso.datetime() }).nullable(),
    trialDays: z.array(z.object({ day: z.string(), messages: z.number(), lastModel: z.string().nullable() })),
    hostedMonthMinutes: z.number(),
    // The hosted lane's standing (hosted-standing.ts): null in good standing.
    hostedSuspended: z.object({ at: z.iso.datetime(), reason: z.string() }).nullable(),
    // The abuse watch's verdicts against this account's machines, newest first (hosted-abuse.ts).
    strikes: z.array(
        z.object({
            appName: z.string(),
            kind: z.enum([`cpu`, `egress`]),
            // In the rule's unit: a CPU busy share 0..1, or GB per hour.
            measure: z.number(),
            windowMinutes: z.number(),
            action: z.enum([`stopped`, `suspended`, `reported`]),
            at: z.iso.datetime(),
        }),
    ),
    wallets: z.array(
        z.object({
            network: z.string(),
            address: z.string(),
            perPaymentMaxUsd: z.string(),
            dailyCapUsd: z.string(),
            payments30d: z.number(),
        }),
    ),
    sandboxes: z.array(AdminUserSandboxSchema),
    // Sandboxes this account is a MEMBER of (owned ones are above).
    memberOf: z.array(z.object({ sandboxName: z.string(), ownerEmail: z.email(), role: z.string(), accepted: z.boolean() })),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

// One account in the operator's directory; counts ride along so the list renders without a per-row round trip.
export const AdminUserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
    createdAt: z.iso.datetime(),
    sandboxCount: z.number(),
    // Stripe's word for plan state, absent when the account never completed a checkout.
    planStatus: z.string().optional(),
    // True when the hosted lane is switched off for this account; absent in good standing.
    hostedSuspended: z.boolean().optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

// Cursor-paged: `nextCursor` is the last row's id, absent on the final page; ordered newest first.
export const AdminUserListSchema = z.object({
    users: z.array(AdminUserSchema),
    total: z.number(),
    nextCursor: z.string().optional(),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

// The daily rollup rows, oldest first, up to 90 days.
// Two kinds of column: window counts are exact for that day, snapshots are the platform as the rollup found it.
export const AdminTrendsSchema = z.object({
    days: z.array(
        z.object({
            day: z.string(),
            newUsers: z.number(),
            trialMessages: z.number(),
            totalUsers: z.number(),
            connectedUsers: z.number(),
            activeSandboxes24h: z.number(),
            plansActive: z.number(),
            hostedMachines: z.number(),
        }),
    ),
});
export type AdminTrends = z.infer<typeof AdminTrendsSchema>;

// What every admin mutation answers: what happened, in a sentence the panel can show verbatim.
export const AdminActionResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export type AdminActionResult = z.infer<typeof AdminActionResultSchema>;
