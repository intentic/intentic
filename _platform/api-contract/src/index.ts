import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    CfTokenSchema,
    CfZonesSchema,
    CloudCredentialsSchema,
    CloudOptionsSchema,
    DaemonUrlSchema,
    ImageDataUrlSchema,
    InviteListSchema,
    InvitePreviewSchema,
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
// the connect script redeems it at the public POST /setup/claim. `emailSetupLink` mails the OWNER a link back to
// that command's own setup screen, which is how a phone — where the command cannot be run and the clipboard
// reaches no terminal — gets the step onto a machine that can finish it; it carries no code and no command, only
// the address of a session-gated page. `attach` is the mirror image of the daemon's
// announce for a sandbox the user already runs behind a domain of their own: the OWNER asserts where it lives,
// after their BROWSER verified it answers (the platform never calls into a sandbox). `leave` drops the
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
        // `image: null` CLEARS the logo — absent means "leave it alone", which is why the field is nullable as
        // well as optional. Without the null the monogram was a one-way door: every picked file could be
        // replaced but never taken back off.
        .input(z.object({ sandboxId: z.string(), name: z.string().min(1).max(60).optional(), image: ImageDataUrlSchema.nullable().optional() }))
        .output(SandboxSummarySchema),
    delete: oc
        .route({ method: "POST", path: "/sandbox/delete" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    zones: oc.route({ method: "POST", path: "/sandbox/zones" }).input(CfTokenSchema).output(CfZonesSchema),
    // The cloud lane (schemas.ts "the cloud lane"): `cloudOptions` validates a pasted provider credential by
    // spending it on the provider's own catalog (regions + sizes with live prices); `cloudProvision` spends it
    // once more to create the ONE VM in the user's account whose first boot runs the sandbox's live setup code
    // — so it requires a fresh `setupCode` mint (mode intentic) first, exactly like the command lane. The
    // credential is request-scoped both times (the zones contract): never persisted, logged, or stored.
    cloudOptions: oc
        .route({ method: "POST", path: "/sandbox/cloud-options" })
        .input(z.object({ credentials: CloudCredentialsSchema }))
        .output(CloudOptionsSchema),
    cloudProvision: oc
        .route({ method: "POST", path: "/sandbox/cloud-provision" })
        .input(z.object({ sandboxId: z.string(), credentials: CloudCredentialsSchema, location: z.string(), size: z.string() }))
        .output(SandboxSummarySchema),
    setupCode: oc
        .route({ method: "POST", path: "/sandbox/setup-code" })
        .input(z.object({ sandboxId: z.string(), target: SetupCodeTargetSchema }))
        .output(SetupCodeSchema),
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

// Sharing a sandbox with teammates by email. Owner side (all take `sandboxId`, owner-only): `list` is the
// access roster; `create` records a pending invite with its granted role and emails the link; `resend` mints a
// fresh link + email; `setRole` re-grades an existing invitee; `revoke` removes an email's access. Invitee
// side (token-facing): `preview` is the public read the accept page renders while logged out; `accept` (session
// required, email-locked) flips the caller's pending invite to an active member. The daemon's own authorized list
// is still pushed by the owner's browser at invite and re-grade time — the server can't reach the daemon.
const sandboxEmailInput = z.object({ sandboxId: z.string(), email: z.email() });
const sandboxGrantInput = z.object({ sandboxId: z.string(), email: z.email(), role: GrantedRoleSchema });
const tokenInput = z.object({ token: z.string() });
export const inviteContract = {
    list: oc.route({ method: "POST", path: "/invite/list" }).input(sandboxIdInput).output(InviteListSchema),
    create: oc.route({ method: "POST", path: "/invite/create" }).input(sandboxGrantInput).output(InviteListSchema),
    resend: oc.route({ method: "POST", path: "/invite/resend" }).input(sandboxEmailInput).output(InviteListSchema),
    setRole: oc.route({ method: "POST", path: "/invite/role" }).input(sandboxGrantInput).output(InviteListSchema),
    revoke: oc.route({ method: "POST", path: "/invite/revoke" }).input(sandboxEmailInput).output(InviteListSchema),
    preview: oc.route({ method: "POST", path: "/invite/preview" }).input(tokenInput).output(InvitePreviewSchema),
    accept: oc
        .route({ method: "POST", path: "/invite/accept" })
        .input(tokenInput)
        .output(z.object({ sandboxId: z.string() })),
};

/* Carrying ONE sign-in from the user's real browser into the desktop app's webview (_editor/desktop-app).
 *
 * Google refuses OAuth from an embedded webview and GIS is FedCM-based, which the Linux webview does not
 * implement — so the app opens /desktop-auth in the DEFAULT browser instead. That page (session required, so
 * this is the ordinary sign-in flow) parks two credentials for exactly one pickup and hands the app a link
 * carrying only the row's id: `handoff` is the app's whole payload, because a deep link is passed as a process
 * argument and is readable by anything on the machine.
 *
 * `redeem` is the mirror, and deliberately SESSIONLESS — the webview has no session yet; that is the point.
 * It answers with the Better Auth one-time token (which the webview spends at /api/auth/one-time-token/verify
 * for its own session cookie) and the Google ID token (spent once at the daemon's system.session). The row is
 * deleted on the first redeem, so a replayed link finds nothing.
 */
export const desktopContract = {
    handoff: oc
        .route({ method: "POST", path: "/desktop/handoff" })
        .input(z.object({ idToken: z.string().min(1) }))
        .output(z.object({ handoff: z.string() })),
    redeem: oc
        .route({ method: "POST", path: "/desktop/redeem" })
        .input(z.object({ handoff: z.string().min(1) }))
        .output(z.object({ ott: z.string(), idToken: z.string() })),
};

// Aggregated contract router — consumed by the oRPC client (ContractRouterClient<typeof apiContract>)
// and implemented on the server by the per-domain implement() route factories.
export const apiContract = {
    me: meContract,
    sandbox: sandboxContract,
    invite: inviteContract,
    desktop: desktopContract,
};
