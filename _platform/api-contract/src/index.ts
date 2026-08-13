import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
    AddressOfferSchema,
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
    MembershipStateSchema,
    PublisherClaimSchema,
    PublisherSlugSchema,
    SandboxSummarySchema,
    SetupCodeSchema,
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
// its switcher logo (a small data URL); `delete` removes an owned one. `setupCode` mints the short-lived
// code the install one-liner carries (and the sandbox's reachability grant on the self-hosted hub with it);
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
    // The zones a pasted Cloudflare token can see — for the in-app Cloudflare capability (the user's own zone,
    // for the deploy engine's apps), not for sandbox reachability, which is self-hosted now. The token is used
    // for that one call and discarded: never persisted, never logged.
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
    /* The HOSTED lane, shaped exactly like the cloud one above: the sandbox ROW is created the ordinary way
     * (`create`, on arrival, whatever lane the user ends up taking), and this pair only decides whether a
     * machine the PLATFORM runs is attached to it. That symmetry is the point — choosing a lane in the wizard
     * moves a machine, never the sandbox, so a switch keeps the name, the row and the address it already has.
     *
     * `hostedOffer` says whether this platform runs sandboxes at all and how many more the caller may have
     * (the editor's zero-click first run and the lane's card both gate on it). `hostedProvision` creates the
     * machine for an existing sandbox — no setup code, no command, the daemon's ordinary announce is the
     * "it's up" signal — and is idempotent, so a retry never doubles a machine. `hostedRelease` is the way
     * back out: it destroys the machine of a sandbox that has NEVER connected (choosing a different lane
     * before anything was set up), and refuses on a live one, where destroying a machine belongs to the
     * delete dialog and its confirmation. `wake` starts a stopped machine (the idle-stop's other half) and
     * answers immediately — the browser keeps probing the daemon like it always does. */
    hostedOffer: oc.route({ method: "GET", path: "/sandbox/hosted-offer" }).output(HostedOfferSchema),
    hostedProvision: oc.route({ method: "POST", path: "/sandbox/hosted-provision" }).input(sandboxIdInput).output(SandboxSummarySchema),
    hostedRelease: oc.route({ method: "POST", path: "/sandbox/hosted-release" }).input(sandboxIdInput).output(SandboxSummarySchema),
    // What the machine itself is doing, asked of the provider — the only part of the wait that exists before
    // the daemon does. Polled ONLY while the wizard is sitting on a hosted wait, which is what keeps a
    // per-row provider call out of `list`.
    hostedStatus: oc.route({ method: "POST", path: "/sandbox/hosted-status" }).input(sandboxIdInput).output(HostedStatusSchema),
    /* Turn a hosted machine off and on again — the recovery for the failures that are the BOX's rather than
     * the sandbox's: a daemon that never came up, and a tunnel that never bound. Both are fixed by rerunning
     * the boot, and neither is fixed by waiting indefinitely, which is what the setup wait offered before.
     *
     * Deliberately not `hostedRelease`: that destroys the machine and its volume, so it refuses a sandbox that
     * has ever connected — correctly, since that is somebody's files. A restart keeps everything and costs the
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
    /* Does this platform hand out addresses at all — the question `setupCode` used to answer only by failing.
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
 * carrying only the row's id. The app also sends a one-way challenge when it starts; redeem requires the
 * verifier retained inside that process, so stealing/racing the deep link cannot collect the credentials.
 *
 * `redeem` is the mirror, and deliberately SESSIONLESS — the webview has no session yet; that is the point.
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
};

// The creator-pool membership, browser side: where the settings card reads its state and where its two
// buttons go. `checkout` and `portal` both answer a Stripe-hosted URL for the browser to navigate to — the
// platform hosts no payment UI of its own. Both refuse (NOT_FOUND) on a platform whose pool is off; the
// daemon-facing and public pool routes (ledger report, premium probe, webhook, transparency) are plain HTTP
// under /pool, not part of this contract, because no browser session could authenticate them.
export const poolContract = {
    membership: oc.route({ method: "GET", path: "/pool/membership" }).output(MembershipStateSchema),
    checkout: oc.route({ method: "POST", path: "/pool/checkout" }).output(z.object({ url: z.url() })),
    portal: oc.route({ method: "POST", path: "/pool/portal" }).output(z.object({ url: z.url() })),
};

/* THE CREATOR'S SIDE of the same pool: proving a publisher name is yours, and connecting somewhere to be paid.
 * The membership routes above are how money comes IN; these are the two things that had to exist before any of
 * it could go OUT, because earnings accrue against a name from a manifest and a name cannot hold a bank
 * account.
 *
 * `challenge` is a READ — it computes what this account would have to publish to prove one name, and changes
 * nothing; `claim` is the verification, and refuses unless the proof is actually readable in a repository the
 * registry lists under that name. `connectPayouts` answers a Stripe-hosted URL like checkout and portal do,
 * for the same reason: the platform hosts no payment UI and collects no bank or tax detail of its own.
 * All four refuse (NOT_FOUND) on a platform whose pool is off. */
export const creatorContract = {
    status: oc.route({ method: "GET", path: "/creator/status" }).output(CreatorStateSchema),
    challenge: oc
        .route({ method: "POST", path: "/creator/claim/challenge" })
        .input(z.object({ publisher: PublisherSlugSchema }))
        .output(ClaimChallengeSchema),
    claim: oc
        .route({ method: "POST", path: "/creator/claim" })
        .input(z.object({ publisher: PublisherSlugSchema }))
        .output(PublisherClaimSchema),
    connectPayouts: oc.route({ method: "POST", path: "/creator/payouts/connect" }).output(z.object({ url: z.url() })),
};

// Aggregated contract router — consumed by the oRPC client (ContractRouterClient<typeof apiContract>)
// and implemented on the server by the per-domain implement() route factories.
export const apiContract = {
    me: meContract,
    sandbox: sandboxContract,
    invite: inviteContract,
    desktop: desktopContract,
    pool: poolContract,
    creator: creatorContract,
};
