import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    AddressOfferSchema,
    OwnerTicketSchema,
    AdminActionResultSchema,
    AdminAttentionSchema,
    AdminCostsSchema,
    AdminFunnelSchema,
    AdminOverviewSchema,
    AdminTrendsSchema,
    AdminUserDetailSchema,
    AdminUserListSchema,
    CfTokenSchema,
    CfZonesSchema,
    DaemonUrlSchema,
    HostedBuildStateSchema,
    HostedBuildStatusSchema,
    HOSTED_PLAN_MAX_SLOTS,
    HostedOfferSchema,
    HostedPlanStateSchema,
    HostedRebuildInputSchema,
    HostedStatusSchema,
    ImageDataUrlSchema,
    InviteListSchema,
    InvitePreviewSchema,
    InviteSentSchema,
    PushDeviceGrantSchema,
    PushDeviceInputSchema,
    PushSendSchema,
    PushSentSchema,
    SandboxSummarySchema,
    SetupCodeSchema,
    UserSchema,
    WalletPolicySchema,
} from "./schemas.js";

export * from "./schemas.js";

// Current authenticated user, or null with no session. `export` is the caller's GDPR data export as JSON; credentials
// (session/OAuth/connect tokens, setup payloads) are excluded.
export const meContract = {
    get: oc.route({ method: "GET", path: "/me" }).output(UserSchema.nullable()),
    export: oc.route({ method: "GET", path: "/me/export" }).output(z.record(z.string(), z.unknown())),
};

// Owner and shared sandboxes; every route takes `sandboxId`, owner-only ones reject non-owners. `attach` records an
// address the owner already runs; the platform never calls into it.
const sandboxIdInput = z.object({ sandboxId: z.string() });
export const sandboxContract = {
    list: oc.route({ method: "GET", path: "/sandbox/list" }).output(z.object({ sandboxes: z.array(SandboxSummarySchema) })),
    create: oc
        .route({ method: "POST", path: "/sandbox/create" })
        .input(z.object({ name: z.string().min(1).max(60) }))
        .output(SandboxSummarySchema),
    update: oc
        .route({ method: "POST", path: "/sandbox/update" })
        // `image: null` clears the logo; absent leaves it alone, so the field must be both nullable and optional.
        .input(z.object({ sandboxId: z.string(), name: z.string().min(1).max(60).optional(), image: ImageDataUrlSchema.nullable().optional() }))
        .output(SandboxSummarySchema),
    delete: oc
        .route({ method: "POST", path: "/sandbox/delete" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    // Zones a pasted Cloudflare token can see, for the in-app capability; the token is used once and discarded.
    zones: oc.route({ method: "POST", path: "/sandbox/zones" }).input(CfTokenSchema).output(CfZonesSchema),
    // Attaches or detaches a platform-run machine on an existing sandbox row; the row itself never changes lanes.
    // `hostedRelease` only destroys a machine that has never connected; `wake` starts a stopped one and returns at
    // once.
    hostedOffer: oc.route({ method: "GET", path: "/sandbox/hosted-offer" }).output(HostedOfferSchema),
    hostedProvision: oc.route({ method: "POST", path: "/sandbox/hosted-provision" }).input(sandboxIdInput).output(SandboxSummarySchema),
    hostedRelease: oc.route({ method: "POST", path: "/sandbox/hosted-release" }).input(sandboxIdInput).output(SandboxSummarySchema),
    // What the machine is doing, asked of the provider; polled only during a hosted wait, never from `list`.
    hostedStatus: oc.route({ method: "POST", path: "/sandbox/hosted-status" }).input(sandboxIdInput).output(HostedStatusSchema),
    // Reboots a hosted machine to recover a daemon or tunnel that never came up, without destroying anything.
    hostedRestart: oc
        .route({ method: "POST", path: "/sandbox/hosted-restart" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    // Builds the approved overlay into the image and reboots; re-hashed against what the owner approved.
    hostedRebuild: oc.route({ method: "POST", path: "/sandbox/hosted-rebuild" }).input(HostedRebuildInputSchema).output(HostedBuildStateSchema),
    hostedBuildStatus: oc.route({ method: "POST", path: "/sandbox/hosted-build-status" }).input(sandboxIdInput).output(HostedBuildStatusSchema),
    wake: oc
        .route({ method: "POST", path: "/sandbox/wake" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    // Whether this platform hands out addresses at all, read beside `hostedOffer` before lanes are drawn.
    addressOffer: oc.route({ method: "GET", path: "/sandbox/address-offer" }).output(AddressOfferSchema),
    // Signed way into a hosted sandbox for its owner; owner-only, hosted-only, 404 elsewhere.
    ownerTicket: oc.route({ method: "POST", path: "/sandbox/owner-ticket" }).input(sandboxIdInput).output(OwnerTicketSchema),
    setupCode: oc.route({ method: "POST", path: "/sandbox/setup-code" }).input(sandboxIdInput).output(SetupCodeSchema),
    emailSetupLink: oc
        .route({ method: "POST", path: "/sandbox/email-setup-link" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    attach: oc
        .route({ method: "POST", path: "/sandbox/attach" })
        .input(z.object({ sandboxId: z.string(), daemonUrl: DaemonUrlSchema }))
        .output(SandboxSummarySchema),
    leave: oc
        .route({ method: "POST", path: "/sandbox/leave" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
};

// Sharing a sandbox by email: owner routes manage the roster; invitee routes are token-facing.
// Delivery is separate from the grant, already in place; the daemon's list is pushed by the owner's own browser.
const sandboxEmailInput = z.object({ sandboxId: z.string(), email: z.email() });
const sandboxGrantInput = z.object({ sandboxId: z.string(), email: z.email(), role: GrantedRoleSchema });
const tokenInput = z.object({ token: z.string() });
export const inviteContract = {
    list: oc.route({ method: "POST", path: "/invite/list" }).input(sandboxIdInput).output(InviteListSchema),
    create: oc.route({ method: "POST", path: "/invite/create" }).input(sandboxGrantInput).output(InviteSentSchema),
    resend: oc.route({ method: "POST", path: "/invite/resend" }).input(sandboxEmailInput).output(InviteSentSchema),
    setRole: oc.route({ method: "POST", path: "/invite/role" }).input(sandboxGrantInput).output(InviteListSchema),
    revoke: oc.route({ method: "POST", path: "/invite/revoke" }).input(sandboxEmailInput).output(InviteListSchema),
    preview: oc.route({ method: "POST", path: "/invite/preview" }).input(tokenInput).output(InvitePreviewSchema),
    accept: oc
        .route({ method: "POST", path: "/invite/accept" })
        .input(tokenInput)
        .output(z.object({ sandboxId: z.string() })),
};

// Carries one sign-in from the real browser into the desktop webview, since Google refuses OAuth (and FedCM) there.
// `redeem` is sessionless by design; the row is deleted on first redeem, so a replayed link finds nothing.
export const desktopContract = {
    handoff: oc
        .route({ method: "POST", path: "/desktop/handoff" })
        .input(z.object({ idToken: z.string().min(1), challenge: z.string().min(43).max(64) }))
        .output(z.object({ handoff: z.string() })),
    redeem: oc
        .route({ method: "POST", path: "/desktop/redeem" })
        .input(z.object({ handoff: z.string().min(1), verifier: z.string().min(43).max(128) }))
        .output(z.object({ ott: z.string(), idToken: z.string() })),

    // The Google ID token this platform already holds, so the desktop hand-off need not ask Google again.
    googleIdToken: oc.route({ method: "POST", path: "/desktop/google-id-token" }).output(z.object({ idToken: z.string().optional() })),
};

// Billing page state and actions; `setSlots` refuses a quantity below the account's current sandbox count.
// `checkout`/`portal` return Stripe-hosted URLs; both 404 on a platform with no plan configured.
export const hostedPlanContract = {
    state: oc.route({ method: "GET", path: "/hosted-plan" }).output(HostedPlanStateSchema),
    checkout: oc.route({ method: "POST", path: "/hosted-plan/checkout" }).output(z.object({ url: z.url() })),
    portal: oc.route({ method: "POST", path: "/hosted-plan/portal" }).output(z.object({ url: z.url() })),
    setSlots: oc
        .route({ method: "POST", path: "/hosted-plan/slots" })
        .input(z.object({ quantity: z.number().int().min(1).max(HOSTED_PLAN_MAX_SLOTS) }))
        .output(HostedPlanStateSchema),
};

/* THE WALLET'S OWNER-SIDE HALF: the spending caps the signer enforces (schemas.ts WalletPolicySchema). The
 * sandbox reaches the signer over plain HTTP with its connect token (/wallet/ensure for an address, /wallet/sign
 * for a signature, neither part of this contract); the caps it is held to come from HERE, a session route the
 * container cannot call. Creates the account's wallet on that network when there is none yet, so the caps can be
 * stated before the sandbox first asks. Refuses (NOT_FOUND) on a platform with no custody provider. */
export const walletContract = {
    setPolicy: oc.route({ method: "POST", path: "/wallet/policy" }).input(WalletPolicySchema).output(WalletPolicySchema),
};

/* THE PUSH RELAY. APNs on behalf of daemons that hold no vendor secret (schemas.ts explains the split).
 *
 * `register`/`unregister` require a session: they are the signed-in web app inside the iOS shell, and a device
 * row belongs to the account that minted it. `send` is SESSIONLESS by design, the caller is a daemon on the
 * owner's own hardware, which has no platform session and never will; the per-device secret from the grant is
 * its whole proof. Expired, unknown, and wrong-secret sends share the daemon's own dead-channel codes (403/410)
 * so one pruning rule works end to end, and everything else answers without an oracle. */
export const pushRelayContract = {
    register: oc.route({ method: "POST", path: "/push/register" }).input(PushDeviceInputSchema).output(PushDeviceGrantSchema),
    unregister: oc
        .route({ method: "POST", path: "/push/unregister" })
        .input(z.object({ deviceId: z.string().min(1) }))
        .output(z.object({ ok: z.boolean() })),
    send: oc.route({ method: "POST", path: "/push/send" }).input(PushSendSchema).output(PushSentSchema),
};

// Operator's read of the deployment, gated by the ADMIN_EMAILS allowlist (requireAdmin), not a role row.
// Read-only until the admin extension is a pinned install; a mutation added later stays behind the same guard.
export const adminContract = {
    overview: oc.route({ method: "GET", path: "/admin/overview" }).output(AdminOverviewSchema),
    // The activation funnel and signups; the panel's most important read.
    funnel: oc.route({ method: "GET", path: "/admin/funnel" }).output(AdminFunnelSchema),
    // Every row that is a person's setup, plan, or machine waiting on a human, as one ordered list of sentences.
    attention: oc.route({ method: "GET", path: "/admin/attention" }).output(AdminAttentionSchema),
    // The bills before the invoice: hosted machines + warm pool, and the trial meter.
    costs: oc.route({ method: "GET", path: "/admin/costs" }).output(AdminCostsSchema),
    users: oc
        .route({ method: "GET", path: "/admin/users" })
        .input(
            z.object({
                // Substring match on email or name, case-insensitive. Absent lists everyone.
                query: z.string().max(200).optional(),
                // The previous page's `nextCursor` (a user id). Absent starts from the newest account.
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(100).default(50),
            }),
        )
        .output(AdminUserListSchema),
    // One account, everything operational, found by id or email (case-insensitive); 404 if neither matches.
    user: oc
        .route({ method: "GET", path: "/admin/user" })
        .input(z.object({ idOrEmail: z.string().min(1).max(200) }))
        .output(AdminUserDetailSchema),
    // The trend lines: the daily rollup rows, oldest first, up to 90 days.
    trends: oc.route({ method: "GET", path: "/admin/trends" }).output(AdminTrendsSchema),

    // The only admin writes: triple-gated by requireAdmin, ADMIN_MUTATIONS, and a `confirm` naming the target exactly.
    // Every mutation audit-logs its target.
    // Stop a hosted machine (abuse/cost brake). The owner can wake it again; nothing is destroyed.
    machineStop: oc
        .route({ method: "POST", path: "/admin/machine/stop" })
        .input(z.object({ sandboxId: z.string().min(1), confirm: z.string() }))
        .output(AdminActionResultSchema),
    // GDPR erasure by email; confirm is the retyped email, then each sandbox is torn down like an owner delete.
    userDelete: oc
        .route({ method: "POST", path: "/admin/user/delete" })
        .input(z.object({ userId: z.string().min(1), confirmEmail: z.string().min(3) }))
        .output(AdminActionResultSchema),
};

// Aggregated contract consumed by the oRPC client and implemented per-domain on the server.
export const apiContract = {
    me: meContract,
    sandbox: sandboxContract,
    invite: inviteContract,
    desktop: desktopContract,
    hostedPlan: hostedPlanContract,
    push: pushRelayContract,
    wallet: walletContract,
    admin: adminContract,
};
