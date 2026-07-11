import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    CfTokenSchema,
    CfZonesSchema,
    ImageDataUrlSchema,
    InviteListSchema,
    InvitePreviewSchema,
    PlanInfoSchema,
    PricingSchema,
    SandboxSummarySchema,
    SetupCodeSchema,
    SetupCodeTargetSchema,
    UserSchema,
} from "./schemas.js";

export * from "./schemas.js";

// Current authenticated user, or null when there is no session. `export` is the GDPR data-export: every
// personal-data row the platform holds for the caller as machine-readable JSON — credentials (session
// tokens, OAuth tokens, sandbox connect tokens, setup payloads) are deliberately excluded.
export const meContract = {
    get: oc.route({ method: "GET", path: "/me" }).output(UserSchema.nullable()),
    export: oc.route({ method: "GET", path: "/me/export" }).output(z.record(z.string(), z.unknown())),
};

// The user's sandboxes + shared access. `list` returns every sandbox the caller owns or is a member of;
// `create` mints a new one (owner) with a fresh connection token; `update` renames an owned one and/or sets
// its switcher logo (a small data URL); `delete` removes an owned one. `zones` lists
// the Cloudflare zones a pasted token can see so the picker can choose one before the install command is revealed
// — the token is used for that one call and discarded (never persisted/logged). `setupCode` mints the short-lived
// code the install one-liner carries (a pure DB write — the intentic tunnel is provisioned lazily at claim time);
// the connect script redeems it at the public POST /setup/claim. `leave` drops the
// caller's own membership. Inviting/managing teammates lives in inviteContract below. Every sandbox-scoped route
// takes a `sandboxId`; owner-only ones reject non-owners.
const sandboxIdInput = z.object({ sandboxId: z.string() });
export const sandboxContract = {
    list: oc.route({ method: "GET", path: "/sandbox/list" }).output(z.object({ sandboxes: z.array(SandboxSummarySchema) })),
    create: oc
        .route({ method: "POST", path: "/sandbox/create" })
        .input(z.object({ name: z.string().min(1).max(60) }))
        .output(SandboxSummarySchema),
    update: oc
        .route({ method: "POST", path: "/sandbox/update" })
        .input(z.object({ sandboxId: z.string(), name: z.string().min(1).max(60).optional(), image: ImageDataUrlSchema.optional() }))
        .output(SandboxSummarySchema),
    delete: oc
        .route({ method: "POST", path: "/sandbox/delete" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    zones: oc.route({ method: "POST", path: "/sandbox/zones" }).input(CfTokenSchema).output(CfZonesSchema),
    setupCode: oc
        .route({ method: "POST", path: "/sandbox/setup-code" })
        .input(z.object({ sandboxId: z.string(), target: SetupCodeTargetSchema }))
        .output(SetupCodeSchema),
    leave: oc
        .route({ method: "POST", path: "/sandbox/leave" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
};

// Sharing a sandbox with teammates by email. Owner side (all take `sandboxId`, owner-only, Pro-gated except
// `revoke` so revocation always works after a downgrade): `list` is the access roster; `create` records a pending
// invite and emails the link; `resend` mints a fresh link + email; `revoke` removes an email's access. Invitee
// side (token-facing): `preview` is the public read the accept page renders while logged out; `accept` (session
// required, email-locked) flips the caller's pending invite to an active member. The daemon's own authorized list
// is still pushed by the owner's browser at invite time — the server can't reach the daemon.
const sandboxEmailInput = z.object({ sandboxId: z.string(), email: z.string().email() });
const tokenInput = z.object({ token: z.string() });
export const inviteContract = {
    list: oc.route({ method: "POST", path: "/invite/list" }).input(sandboxIdInput).output(InviteListSchema),
    create: oc.route({ method: "POST", path: "/invite/create" }).input(sandboxEmailInput).output(InviteListSchema),
    resend: oc.route({ method: "POST", path: "/invite/resend" }).input(sandboxEmailInput).output(InviteListSchema),
    revoke: oc.route({ method: "POST", path: "/invite/revoke" }).input(sandboxEmailInput).output(InviteListSchema),
    preview: oc.route({ method: "POST", path: "/invite/preview" }).input(tokenInput).output(InvitePreviewSchema),
    accept: oc
        .route({ method: "POST", path: "/invite/accept" })
        .input(tokenInput)
        .output(z.object({ sandboxId: z.string() })),
};

// The platform's own billing. `pricing` returns the live "pro" price (read from Stripe) so the upgrade dialog
// can show the real figure; NOT_FOUND when billing is unconfigured. `plan` returns the caller's server-resolved
// tier + entitlements (reads only Postgres, so it works with Stripe unconfigured); gated routes throw
// PAYMENT_REQUIRED (402). Checkout/portal/webhook stay with the Better Auth stripe plugin (mounted under
// /api/auth), not oRPC.
export const billingContract = {
    pricing: oc.route({ method: "GET", path: "/billing/pricing" }).output(PricingSchema),
    plan: oc.route({ method: "GET", path: "/billing/plan" }).output(PlanInfoSchema),
};

// Aggregated contract router — consumed by the oRPC client (ContractRouterClient<typeof apiContract>)
// and implemented on the server by the per-domain implement() route factories.
export const apiContract = {
    me: meContract,
    billing: billingContract,
    sandbox: sandboxContract,
    invite: inviteContract,
};
