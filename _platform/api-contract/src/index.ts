import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    AddressOfferSchema,
    AdminActionResultSchema,
    AdminAttentionSchema,
    AdminCostsSchema,
    AdminFunnelSchema,
    AdminMarketSchema,
    AdminOverviewSchema,
    AdminTrendsSchema,
    AdminUserDetailSchema,
    AdminUserListSchema,
    ClaimableNamesSchema,
    ClaimChallengeSchema,
    CloudCredentialsSchema,
    CloudOptionsSchema,
    CreatorStateSchema,
    CfTokenSchema,
    CfZonesSchema,
    DaemonUrlSchema,
    HostedOfferSchema,
    HostedStatusSchema,
    ImageDataUrlSchema,
    InviteListSchema,
    InvitePreviewSchema,
    InviteSentSchema,
    MembershipStateSchema,
    ProviderServiceSchema,
    ProviderServicesStateSchema,
    PublisherClaimSchema,
    PublisherSlugSchema,
    PushDeviceGrantSchema,
    PushDeviceInputSchema,
    PushSendSchema,
    PushSentSchema,
    SandboxSummarySchema,
    ServiceListingInputSchema,
    ServiceOfferCardSchema,
    ServiceOfferSettledSchema,
    ServiceProbeResultSchema,
    SetupCodeSchema,
    UserSchema,
} from "./schemas.js";

export * from "./schemas.js";

// Current authenticated user, or null when there is no session. `export` is the GDPR data-export: every
// personal-data row the platform holds for the caller as machine-readable JSON, credentials (session
// tokens, OAuth tokens, sandbox connect tokens, setup payloads) are deliberately excluded.
export const meContract = {
    get: oc.route({ method: "GET", path: "/me" }).output(UserSchema.nullable()),
    export: oc.route({ method: "GET", path: "/me/export" }).output(z.record(z.string(), z.unknown())),
};

// The user's sandboxes + shared access. `list` returns every sandbox the caller owns or is a member of;
// `create` mints a new one (owner) with a fresh connection token; `update` renames an owned one and/or sets
// its switcher logo (a small data URL); `delete` removes an owned one. `setupCode` mints the short-lived
// code the install one-liner carries (and the sandbox's reachability grant on the self-hosted hub with it);
// the connect script redeems it at the public POST /setup/claim. `emailSetupLink` mails the OWNER a link back to
// that command's own setup screen, which is how a phone, where the command cannot be run and the clipboard
// reaches no terminal, gets the step onto a machine that can finish it; it carries no code and no command, only
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
        // `image: null` CLEARS the logo, absent means "leave it alone", which is why the field is nullable as
        // well as optional. Without the null the monogram was a one-way door: every picked file could be
        // replaced but never taken back off.
        .input(z.object({ sandboxId: z.string(), name: z.string().min(1).max(60).optional(), image: ImageDataUrlSchema.nullable().optional() }))
        .output(SandboxSummarySchema),
    delete: oc
        .route({ method: "POST", path: "/sandbox/delete" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    // The zones a pasted Cloudflare token can see, for the in-app Cloudflare capability (the user's own zone,
    // for the deploy engine's apps), not for sandbox reachability, which is self-hosted now. The token is used
    // for that one call and discarded: never persisted, never logged.
    zones: oc.route({ method: "POST", path: "/sandbox/zones" }).input(CfTokenSchema).output(CfZonesSchema),
    // The cloud lane (schemas.ts "the cloud lane"): `cloudOptions` validates a pasted provider credential by
    // spending it on the provider's own catalog (regions + sizes with live prices); `cloudProvision` spends it
    // once more to create the ONE VM in the user's account whose first boot runs the sandbox's live setup code
    //, so it requires a fresh `setupCode` mint (mode intentic) first, exactly like the command lane. The
    // credential is request-scoped both times (the zones contract): never persisted, logged, or stored.
    cloudOptions: oc
        .route({ method: "POST", path: "/sandbox/cloud-options" })
        .input(z.object({ credentials: CloudCredentialsSchema }))
        .output(CloudOptionsSchema),
    cloudProvision: oc
        .route({ method: "POST", path: "/sandbox/cloud-provision" })
        .input(z.object({ sandboxId: z.string(), credentials: CloudCredentialsSchema, location: z.string(), size: z.string() }))
        .output(SandboxSummarySchema),
    /* The HOSTED lane, shaped exactly like the cloud one above: the sandbox ROW is created the ordinary way
     * (`create`, on arrival, whatever lane the user ends up taking), and this pair only decides whether a
     * machine the PLATFORM runs is attached to it. That symmetry is the point, choosing a lane in the wizard
     * moves a machine, never the sandbox, so a switch keeps the name, the row and the address it already has.
     *
     * `hostedOffer` says whether this platform runs sandboxes at all and how many more the caller may have
     * (the editor's zero-click first run and the lane's card both gate on it). `hostedProvision` creates the
     * machine for an existing sandbox, no setup code, no command, the daemon's ordinary announce is the
     * "it's up" signal, and is idempotent, so a retry never doubles a machine. `hostedRelease` is the way
     * back out: it destroys the machine of a sandbox that has NEVER connected (choosing a different lane
     * before anything was set up), and refuses on a live one, where destroying a machine belongs to the
     * delete dialog and its confirmation. `wake` starts a stopped machine (the idle-stop's other half) and
     * answers immediately, the browser keeps probing the daemon like it always does. */
    hostedOffer: oc.route({ method: "GET", path: "/sandbox/hosted-offer" }).output(HostedOfferSchema),
    hostedProvision: oc.route({ method: "POST", path: "/sandbox/hosted-provision" }).input(sandboxIdInput).output(SandboxSummarySchema),
    hostedRelease: oc.route({ method: "POST", path: "/sandbox/hosted-release" }).input(sandboxIdInput).output(SandboxSummarySchema),
    // What the machine itself is doing, asked of the provider, the only part of the wait that exists before
    // the daemon does. Polled ONLY while the wizard is sitting on a hosted wait, which is what keeps a
    // per-row provider call out of `list`.
    hostedStatus: oc.route({ method: "POST", path: "/sandbox/hosted-status" }).input(sandboxIdInput).output(HostedStatusSchema),
    /* Turn a hosted machine off and on again, the recovery for the failures that are the BOX's rather than
     * the sandbox's: a daemon that never came up, and a tunnel that never bound. Both are fixed by rerunning
     * the boot, and neither is fixed by waiting indefinitely, which is what the setup wait offered before.
     *
     * Deliberately not `hostedRelease`: that destroys the machine and its volume, so it refuses a sandbox that
     * has ever connected, correctly, since that is somebody's files. A restart keeps everything and costs the
     * seconds of a boot, which makes it the one recovery safe enough to put under a failure message. It is
     * also what the idle-stop does to every hosted sandbox routinely, so it is a well-worn path, not a new
     * kind of event. */
    hostedRestart: oc
        .route({ method: "POST", path: "/sandbox/hosted-restart" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    wake: oc
        .route({ method: "POST", path: "/sandbox/wake" })
        .input(sandboxIdInput)
        .output(z.object({ ok: z.boolean() })),
    /* Does this platform hand out addresses at all, the question `setupCode` used to answer only by failing.
     * Shaped like `hostedOffer` and read beside it on arrival, so the wizard knows which lanes exist before it
     * draws them: a platform with no tunnel fabric can offer neither the pasted command nor a cloud machine,
     * and its reader belongs in the attach lane from the first frame rather than after a mint 404s. */
    addressOffer: oc.route({ method: "GET", path: "/sandbox/address-offer" }).output(AddressOfferSchema),
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

// Sharing a sandbox with teammates by email. Owner side (all take `sandboxId`, owner-only): `list` is the
// access roster; `create` records a pending invite with its granted role and emails the link; `resend` mints a
// fresh link + email; `setRole` re-grades an existing invitee; `revoke` removes an email's access. The two that
// mail answer with the link and HOW IT TRAVELLED (InviteSentSchema), the grant is already in place by then, so
// a declined or refused send is a fact about delivery, never a failed invite. Invitee
// side (token-facing): `preview` is the public read the accept page renders while logged out; `accept` (session
// required, email-locked) flips the caller's pending invite to an active member. The daemon's own authorized list
// is still pushed by the owner's browser at invite and re-grade time, the server can't reach the daemon.
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

/* Carrying ONE sign-in from the user's real browser into the desktop app's webview (_editor/desktop-app).
 *
 * Google refuses OAuth from an embedded webview and GIS is FedCM-based, which the Linux webview does not
 * implement, so the app opens /desktop-auth in the DEFAULT browser instead. That page signs the browser in if
 * it is not already (the OS default browser is routinely a profile nobody has signed in), then parks two
 * credentials for exactly one pickup and hands the app a link carrying only the row's id. The app also sends a
 * one-way challenge when it starts; redeem requires the verifier retained inside that process, so
 * stealing/racing the deep link cannot collect the credentials.
 *
 * `redeem` is the mirror, and deliberately SESSIONLESS, the webview has no session yet; that is the point.
 * It answers with the Better Auth one-time token (which the webview spends at /api/auth/one-time-token/verify
 * for its own session cookie) and the Google ID token (spent once at the daemon's system.session). The row is
 * deleted on the first redeem, so a replayed link finds nothing.
 */
export const desktopContract = {
    handoff: oc
        .route({ method: "POST", path: "/desktop/handoff" })
        .input(z.object({ idToken: z.string().min(1), challenge: z.string().min(43).max(64) }))
        .output(z.object({ handoff: z.string() })),
    redeem: oc
        .route({ method: "POST", path: "/desktop/redeem" })
        .input(z.object({ handoff: z.string().min(1), verifier: z.string().min(43).max(128) }))
        .output(z.object({ ott: z.string(), idToken: z.string() })),

    /* The Google ID token this platform ALREADY holds for the signed-in user, so the hand-off page does not
     * have to ask Google a second time for a credential the browser just proved it has.
     *
     * Scoped to the desktop hand-off on purpose, and it is the one place worth the trade. Everywhere else the
     * browser mints its own token and this platform never issues one, the property the sandbox daemon's
     * comment describes. Here the alternative is worse: the app has already sent someone to their browser,
     * and if Google's in-page button cannot run (a blocked frame, an origin Google is refusing, a webview
     * that has no FedCM) they are left on a screen with no way forward and no way to tell why.
     *
     * The token is Google-signed either way, same issuer, same audience, verified against Google's JWKS by
     * the daemon exactly as before. What changes is only WHO handed the browser the bytes. Optional output
     * because "we hold nothing usable" is an ordinary answer (a sign-in that left no refresh token), and the
     * page's answer to it is the Google button it already shows. */
    googleIdToken: oc.route({ method: "POST", path: "/desktop/google-id-token" }).output(z.object({ idToken: z.string().optional() })),
};

// The creator-pool membership, browser side: where the settings card reads its state and where its two
// buttons go. `checkout` and `portal` both answer a Stripe-hosted URL for the browser to navigate to, the
// platform hosts no payment UI of its own. Both refuse (NOT_FOUND) on a platform whose pool is off; the
// daemon-facing and public pool routes (ledger report, premium probe, webhook, transparency) are plain HTTP
// under /pool, not part of this contract, because no browser session could authenticate them.
export const poolContract = {
    membership: oc.route({ method: "GET", path: "/pool/membership" }).output(MembershipStateSchema),
    /* `returnTo` names WHICH buying surface asked, because there are two now and they are not the same journey.
     * `settings` is somebody already inside the product; `join` is somebody who arrived from a terminal with no
     * sandbox and must not be dropped into a workspace shell that would bounce them to setup.
     *
     * An enum rather than a URL, deliberately: a caller-supplied return address on a payment redirect is an
     * open redirect waiting to be found, and there are exactly two lanes to name. */
    checkout: oc
        .route({ method: "POST", path: "/pool/checkout" })
        .input(z.object({ returnTo: z.enum([`settings`, `join`]).optional() }))
        .output(z.object({ url: z.url() })),
    portal: oc.route({ method: "POST", path: "/pool/portal" }).output(z.object({ url: z.url() })),

    /* THE SPEND GATE'S BROWSER HALF, the two calls behind the approval page an agent outside a sandbox sends
     * its owner to (api mcp/mcp-offer.ts). In a sandbox this pair is a card frame and a click inside the
     * conversation; here it has to be a page, because a Claude Code session has no conversation of ours to
     * draw in and no held connection to wait on.
     *
     * These are the ONLY door from `pending` to `approved`, and they live on the browser contract rather than
     * beside the MCP routes for exactly that reason: a session cookie is the one credential the calling agent
     * cannot obtain, hold, or forge. The agent's own claim that its user consented is never read anywhere. */
    offer: oc
        .route({ method: "GET", path: "/pool/offers/{id}" })
        .input(z.object({ id: z.string() }))
        .output(ServiceOfferCardSchema),
    settleOffer: oc
        .route({ method: "POST", path: "/pool/offers/{id}/settle" })
        .input(z.object({ id: z.string(), approve: z.boolean() }))
        .output(ServiceOfferSettledSchema),
};

/* THE CREATOR'S SIDE of the same pool: proving a publisher name is yours, and connecting somewhere to be paid.
 * The membership routes above are how money comes IN; these are the two things that had to exist before any of
 * it could go OUT, because earnings accrue against a name from a manifest and a name cannot hold a bank
 * account.
 *
 * `challenge` is a READ, it computes what this account would have to publish to prove one name, and changes
 * nothing; `claim` is the verification, and refuses unless the proof is actually readable in a repository the
 * registry lists under that name. `connectPayouts` answers a Stripe-hosted URL like checkout and portal do,
 * for the same reason: the platform hosts no payment UI and collects no bank or tax detail of its own.
 * All four refuse (NOT_FOUND) on a platform whose pool is off. */
/* OPEN ADMISSION, the provider's side: how a third-party business lists a metered service without an
 * operator. The gates it is judged by are published as data on `list` rather than described in prose, so a
 * provider reads the same numbers the algorithm applies (docs/services-admission-design.md).
 *
 * `probe` is its own call rather than a step inside `publish` because it reaches out and hits the provider's
 * endpoint three times: whose endpoint gets called and when is theirs to choose. `publish` only checks that a
 * passing probe is recent, which is what makes the gate honest, a probe's whole claim is about right now.
 *
 * `draft` and `rotateSecret` are the only two places a signing secret is ever readable, and each answers it
 * exactly once; nothing reads one back, so a stolen session cannot harvest what it did not watch being made. */
export const serviceContract = {
    list: oc.route({ method: "GET", path: "/creator/services" }).output(ProviderServicesStateSchema),
    draft: oc
        .route({ method: "POST", path: "/creator/services" })
        .input(ServiceListingInputSchema)
        .output(z.object({ service: ProviderServiceSchema, secret: z.string() })),
    update: oc
        .route({ method: "POST", path: "/creator/services/{slug}" })
        .input(ServiceListingInputSchema.omit({ slug: true, publisher: true }).partial().extend({ slug: z.string() }))
        .output(ProviderServiceSchema),
    probe: oc
        .route({ method: "POST", path: "/creator/services/{slug}/probe" })
        .input(z.object({ slug: z.string() }))
        .output(ServiceProbeResultSchema),
    publish: oc
        .route({ method: "POST", path: "/creator/services/{slug}/publish" })
        .input(z.object({ slug: z.string() }))
        .output(ProviderServiceSchema),
    withdraw: oc
        .route({ method: "POST", path: "/creator/services/{slug}/withdraw" })
        .input(z.object({ slug: z.string() }))
        .output(ProviderServiceSchema),
    rotateSecret: oc
        .route({ method: "POST", path: "/creator/services/{slug}/secret" })
        .input(z.object({ slug: z.string() }))
        .output(z.object({ secret: z.string() })),
};

export const creatorContract = {
    status: oc.route({ method: "GET", path: "/creator/status" }).output(CreatorStateSchema),
    /* Publisher names the caller's own repositories back, what the claim screen offers instead of an empty box.
     * `projects` are `owner/name` slugs the caller says they have; nothing is trusted about them beyond being a
     * filter, because the proof is still a file only somebody with push access can put there. */
    claimable: oc
        .route({ method: "POST", path: "/creator/claim/claimable" })
        .input(z.object({ projects: z.array(z.string().min(1)).max(200) }))
        .output(ClaimableNamesSchema),
    challenge: oc
        .route({ method: "POST", path: "/creator/claim/challenge" })
        .input(z.object({ publisher: PublisherSlugSchema }))
        .output(ClaimChallengeSchema),
    claim: oc
        .route({ method: "POST", path: "/creator/claim" })
        .input(z.object({ publisher: PublisherSlugSchema }))
        .output(PublisherClaimSchema),
    connectPayouts: oc.route({ method: "POST", path: "/creator/payouts/connect" }).output(z.object({ url: z.url() })),
    services: serviceContract,
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

/* THE ADMIN SURFACE — the operator's read of their own deployment, gated by the ADMIN_EMAILS allowlist
 * (api guards.ts requireAdmin) rather than any role row: a session whose Google-verified email is on the
 * deployment's list may call these, everyone else gets FORBIDDEN, and a platform that never configured the
 * list has no admin surface at all. Consumed by the private platform-admin extension riding the SPA's own
 * Better Auth session — there is deliberately no second authentication system behind this namespace.
 *
 * READ-ONLY BY DESIGN for now: the panel's bytes are workspace-authored (agent-writable), so until the
 * extension graduates to a pinned install, nothing here may mutate. A mutation added later belongs in this
 * namespace, behind the same guard, with its own explicit confirmation input. */
export const adminContract = {
    overview: oc.route({ method: "GET", path: "/admin/overview" }).output(AdminOverviewSchema),
    // The activation funnel + signups: the panel's most important read (see AdminFunnelSchema).
    funnel: oc.route({ method: "GET", path: "/admin/funnel" }).output(AdminFunnelSchema),
    // The red-rows feed: every row that is a person's setup, money, or listing waiting on a human, as one
    // ordered list of server-composed sentences. One endpoint on purpose — the operator's first question is
    // "what needs me today", not seven cards to scan.
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
    // The support page: one account, everything operational, by id or email (case-insensitive). 404 when
    // neither matches.
    user: oc
        .route({ method: "GET", path: "/admin/user" })
        .input(z.object({ idOrEmail: z.string().min(1).max(200) }))
        .output(AdminUserDetailSchema),
    // The marketplace: demand (wants aggregate) beside supply (every listing against the published rules).
    market: oc.route({ method: "GET", path: "/admin/market" }).output(AdminMarketSchema),
    // The trend lines: the daily rollup rows, oldest first, up to 90 days.
    trends: oc.route({ method: "GET", path: "/admin/trends" }).output(AdminTrendsSchema),

    /* MUTATIONS — the only writes on the admin surface, and triple-gated: requireAdmin (who), the
     * ADMIN_MUTATIONS deployment switch (whether this deployment allows them at all — off until the panel
     * is a pinned install), and a typed `confirm` input that must name the target exactly (the retype-it
     * pattern; a mistyped confirmation is a 400, not a warning). Every one audit-logs its target. */
    serviceSuspend: oc
        .route({ method: "POST", path: "/admin/service/suspend" })
        .input(z.object({ slug: z.string().min(1), reason: z.string().min(1).max(500), confirm: z.string() }))
        .output(AdminActionResultSchema),
    // Reinstates into PROBATION, not `listed`: the price cap and the badge are exactly what a listing that
    // was just suspended should re-enter under.
    serviceReinstate: oc
        .route({ method: "POST", path: "/admin/service/reinstate" })
        .input(z.object({ slug: z.string().min(1), confirm: z.string() }))
        .output(AdminActionResultSchema),
    // Re-attempt one reserved-but-unpaid payout under its original idempotency key.
    payoutRetry: oc
        .route({ method: "POST", path: "/admin/payout/retry" })
        .input(z.object({ payoutId: z.string().min(1), confirm: z.string() }))
        .output(AdminActionResultSchema),
    // Stop a hosted machine (abuse/cost brake). The owner can wake it again; nothing is destroyed.
    machineStop: oc
        .route({ method: "POST", path: "/admin/machine/stop" })
        .input(z.object({ sandboxId: z.string().min(1), confirm: z.string() }))
        .output(AdminActionResultSchema),
    /* GDPR erasure on the operator's side (Art. 17 requests arriving by email rather than through
     * Settings). Confirm is the account's EMAIL retyped — the strongest of these confirmations because this
     * is the one action with nothing on the other side of it. Tears down each sandbox the way the owner's
     * own delete does (reachability grant, hosted machine), then lets the cascade take every row. */
    userDelete: oc
        .route({ method: "POST", path: "/admin/user/delete" })
        .input(z.object({ userId: z.string().min(1), confirmEmail: z.string().min(3) }))
        .output(AdminActionResultSchema),
};

// Aggregated contract router, consumed by the oRPC client (ContractRouterClient<typeof apiContract>)
// and implemented on the server by the per-domain implement() route factories.
export const apiContract = {
    me: meContract,
    sandbox: sandboxContract,
    invite: inviteContract,
    desktop: desktopContract,
    pool: poolContract,
    creator: creatorContract,
    push: pushRelayContract,
    admin: adminContract,
};
