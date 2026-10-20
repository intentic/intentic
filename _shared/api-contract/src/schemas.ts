import type { ResourceType } from "@intentic/resources";
import { GrantedRoleSchema, MemberRoleSchema } from "@intentic/sandbox-contract/schemas/shared";
import { PushNotificationSchema } from "@intentic/sandbox-contract/schemas/push";
import { WalletNetworkSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import { BootReportSchema, HostReportSchema, SetupReportSchema } from "./ingress/ingress-schemas.js";

// Where the oRPC handler is mounted; the client link uses the same base so request URLs line up.
export const API_BASE_PATH = "/rpc";

// What machines send the platform outside /rpc (the setup claim and report, announce, boot and host reports), which the
// editor reads back off a sandbox's summary: declared with the ingress routes that carry them.
export * from "./ingress/index.js";

// ---- platform-native shapes. A daemon wire shape is imported from @intentic/sandbox-contract, never through here ----

// How an account can prove its address: a Google sign-in, or a code mailed to it. An account holds one or both, and
// the editor picks the proof it spends on a daemon from this (an identity assertion only for an `email` account).
export const SignInMethodSchema = z.enum(["google", "email"]);
export type SignInMethod = z.infer<typeof SignInMethodSchema>;

export const UserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
    // Absent from a platform from before email sign-in, where every account is a Google one.
    signInMethods: z.array(SignInMethodSchema).optional(),
    // When the account was made. The app reads it to tell a sign-up from a return (analytics.ts `signed_up`); absent
    // from a platform from before 2026-10-15.
    createdAt: z.iso.datetime().optional(),
});
export type User = z.infer<typeof UserSchema>;

// What this platform lets a person sign in with, read by the login page before anyone has. `email` is off on a platform
// that cannot send mail.
export const SignInOptionsSchema = z.object({ google: z.boolean(), email: z.boolean() });
export type SignInOptions = z.infer<typeof SignInOptionsSchema>;

// The caller's hosted-plan billing state; `enabled: false` means the page doesn't exist at all.
// `cancelAtPeriodEnd` turns "renews" into "ends": a cancel leaves `status` active until the period runs out.
// A machine's own shape, as the row records it rather than as its rung would imply: the two differ mid-migration
// and after any edit to the ladder, and this is the one a person's machine actually is.
export const HostedShapeSchema = z.object({
    cpuKind: z.enum(["shared", "performance"]),
    cpus: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    volumeGb: z.number().int().positive(),
});

/* ONE KIND OF HOSTED HOURS, and this month of it. There are two kinds (api hosted-usage.ts), and every awake minute of
 * a hosted machine is charged to exactly one: the ACCOUNT's free hours, spent by every machine that does not stand on
 * a paid slot (released ones included), and ONE MACHINE's own month at the rung of the paid slot it stands on. A
 * sandbox on the owner's own computer spends neither: nothing of the platform's runs, so nothing is counted. */
export const HostedHoursMeterSchema = z.object({
    kind: z.enum(["free", "slot"]),
    // Awake minutes spent from these hours this month, live: a machine that is up right now counts since it woke.
    usedMinutes: z.number().int().nonnegative(),
    // The ceiling in minutes; null when nothing is counted against one (a comped account, a platform with no ceiling).
    allowanceMinutes: z.number().int().nonnegative().nullable(),
    // When the month rolls over (the first of next month, UTC).
    resetsAt: z.iso.datetime(),
    // Present while the free hours are a new account's ramp rather than the month's figure: when the full one applies.
    rampUntil: z.iso.datetime().optional(),
});
export type HostedHoursMeter = z.infer<typeof HostedHoursMeterSchema>;

export const HostedPlanMachineSchema = z.object({
    sandboxId: z.string(),
    name: z.string(),
    region: z.string(),
    // Awake since (or stopped with its stretch not yet settled). Null when asleep and settled.
    wokeAt: z.iso.datetime().nullable(),
    // Which rung sold this machine, and what it actually is.
    tier: z.string(),
    shape: HostedShapeSchema,
    // The hours this machine spends: its own month while it stands on a paid slot, otherwise the account's free hours,
    // in which case these are the same figures as `freeHours` below.
    hours: HostedHoursMeterSchema,
    // Times the kernel killed this machine for memory in the last week. A fact, and the only honest reason to put a
    // bigger machine in front of somebody; 0 says nothing and shows nothing.
    oomsThisWeek: z.number().int().nonnegative(),
});
export type HostedPlanMachine = z.infer<typeof HostedPlanMachineSchema>;

export const HostedPlanHostedSchema = z.object({
    // Hosted sandboxes this account may have in total, and how many at each rung; a machine occupies one slot at
    // its own rung, so the page can say "1 of 2 Standard" as well as "2 of 3".
    slots: z.number().int().nonnegative(),
    slotsByTier: z.record(z.string(), z.number().int().nonnegative()),
    machines: z.array(HostedPlanMachineSchema),
    // The account's free hours (`kind` is always `free`): what every machine off a paid slot spends, and what a new
    // hosted sandbox starts on. Present with no machine at all, since a released machine's minutes stay in it.
    freeHours: HostedHoursMeterSchema,
    // The rung a machine lands on with nothing bought, and the shape this deployment gives it: an operator running
    // their own fleet may size the free rung differently from the published ladder.
    freeTier: z.object({ id: z.string(), shape: HostedShapeSchema, monthlyHours: z.number().int().nonnegative() }),
});
export type HostedPlanHosted = z.infer<typeof HostedPlanHostedSchema>;

export const HostedPlanStateSchema = z.object({
    enabled: z.boolean(),
    onPlan: z.boolean(),
    comped: z.boolean().optional(),
    status: z.string().optional(),
    renewsAt: z.iso.datetime().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    priceUsd: z.number(),
    hosted: HostedPlanHostedSchema.optional(),
});
export type HostedPlanState = z.infer<typeof HostedPlanStateSchema>;

// Most hosted sandboxes one plan sells; reachable by pressing a button, absorbable without review.
export const HOSTED_PLAN_MAX_SLOTS = 10;

/* ONE ATTEMPT TO MOVE A SANDBOX BETWEEN MACHINES, as the Billing page watches it. `state` walks
 * planned → snapshotting → applying → verifying → done, or ends at failed/rolledBack; `rolledBack` means the
 * machine was changed and put back, `failed` that nothing was changed at all. */
export const HostedMigrationSchema = z.object({
    id: z.string(),
    sandboxId: z.string(),
    kind: z.enum(["resize", "move"]),
    state: z.enum(["planned", "snapshotting", "applying", "verifying", "done", "failed", "rolledBack"]),
    fromTier: z.string(),
    toTier: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().optional(),
    // Why it ended where it did, in words a person can act on; absent while it is still going or once done.
    error: z.string().optional(),
});
export type HostedMigration = z.infer<typeof HostedMigrationSchema>;

// Avatars/logos as inline data URLs, client-downscaled; caps what the API persists in a row.
export const ImageDataUrlSchema = z.string().startsWith("data:image/").max(150_000);

// Remove-by-name input for inventory routes; one sandbox per user, so the name identifies the entry.
export const RemoveInventoryInputSchema = z.object({
    name: z.string().min(1),
});
export type RemoveInventoryInput = z.infer<typeof RemoveInventoryInputSchema>;

// Live infra read: streams `intentic deploy plan` (no apply) over SSE, distinct from the cached status.json.
// `action` is the reconcile verdict: noop, create, update (with a reason), delete/prune.
export interface PlanStreamEvent {
    readonly type: "node" | "result" | "error" | "done";
    // For type "node": the resource id + its reconcile verdict against live infra.
    readonly id?: string;
    readonly resourceType?: string;
    readonly action?: string;
    readonly reason?: string;
    // For type "result": resources found live but absent from the desired graph.
    readonly orphans?: readonly string[];
    // For type "error".
    readonly message?: string;
}

// ---- sandboxes: the user's workspaces + shared access ----

// Two copies of one sandbox seen announcing side by side, on the owner's summary: what each copy named itself as
// (`rog (windows)`, `rog (linux)`), and since when. The tunnel keeps only one of them at a time, so the other is an
// agent and a disk nobody can reach; the owner is the one who decides which copy goes.
export const DuplicateCopiesSchema = z.object({ hosts: z.array(z.string()), since: z.string() });
export type DuplicateCopies = z.infer<typeof DuplicateCopiesSchema>;

// A short-lived code the recovery panel puts in the command it hands out, so the run can report back to the page that
// asked for it without a credential in the shell's history. Owner-only, own-machine sandboxes only.
export const FixCodeSchema = z.object({ code: z.string(), expiresAt: z.string() });
export type FixCode = z.infer<typeof FixCodeSchema>;

// A check-in the platform turned away, kept so the refusal isn't silent to every screen.
// Carries both the announced and expected address, since the browser can't derive the expected one itself.
export const AnnounceRefusalSchema = z.object({ announced: z.string(), expected: z.string() });
export type AnnounceRefusal = z.infer<typeof AnnounceRefusalSchema>;

// The hosted machine's power state, asked of the provider; its own route so a list avoids one call per row.
// `unknown` means keep waiting; `gone` means stop, the machine or app no longer exists.
export const HostedStatusSchema = z.object({
    machine: z.enum([
        "unknown",
        "gone",
        "created",
        "starting",
        "started",
        "stopping",
        "stopped",
        "suspended",
        "replacing",
        "destroying",
        "destroyed",
        "failed",
    ]),
});
export type HostedStatus = z.infer<typeof HostedStatusSchema>;

// A hosted sandbox's overlay build, since there's no host to run `ic sandbox rebuild` and watch.
// `hash` is the approved content's sha256; `log` is builder output, present above all for a failed RUN step.
export const HostedBuildStateSchema = z.object({
    state: z.enum(["building", "built", "failed"]),
    hash: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
    log: z.string().optional(),
});
export type HostedBuildState = z.infer<typeof HostedBuildStateSchema>;

// Largest overlay the platform will build; far past any real recipe, short of an abusive one.
export const HOSTED_OVERLAY_MAX_BYTES = 256 * 1024;

// What the browser sends to build an overlay: content and hash, read off the daemon's /environment route.
// The platform re-hashes it, so only bytes matching what the owner reviewed get built.
export const HostedRebuildInputSchema = z.object({
    sandboxId: z.string(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.string().min(1).max(HOSTED_OVERLAY_MAX_BYTES),
});
export type HostedRebuildInput = z.infer<typeof HostedRebuildInputSchema>;

// The build in flight or last finished, null if never asked; `applied` is the hash last booted.
export const HostedBuildStatusSchema = z.object({
    build: HostedBuildStateSchema.nullable(),
    applied: z.string().nullable(),
});
export type HostedBuildStatus = z.infer<typeof HostedBuildStatusSchema>;

// The hosted machine as the browser sees it; its presence means "call wake", never "it's gone".
// State is a placement hint; only a daemon answer proves reachability. Older platforms omit it.
export const SandboxHostedSchema = z.object({
    state: z.enum(["awake", "asleep", "starting", "down", "unknown"]).optional(),
    region: z.string(),
    // Whether the machine came warm from the pool (seconds) or was built to order (a cold image pull, minutes).
    warm: z.boolean(),
    // The platform kept the image the machine ran before its last image change, so `hostedRollback` can go back to it.
    // Absent from a platform older than the field, and false until a machine has changed image once.
    canRollBack: z.boolean().optional(),
});
export type SandboxHosted = z.infer<typeof SandboxHostedSchema>;

// The hosted lane's offer, read before creation; `remaining` is this caller's own allowance left.
// `hours` is the account's free hours, which is what a new machine spends: it arrives on the free rung, a subscriber's
// included. Absent where nothing is counted against them (a comped account, a platform with no ceiling).
export const HostedHoursSchema = z.object({
    // Monthly ceiling and what's left, in whole hours; `remaining` floors, so "1 hour left" isn't a few minutes.
    allowance: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    // Present while a new account's ceiling is the ramp's rather than the month's: when the full one applies (ISO).
    rampUntil: z.iso.datetime().optional(),
});
export type HostedHours = z.infer<typeof HostedHoursSchema>;

export const HostedOfferSchema = z.object({
    enabled: z.boolean(),
    remaining: z.number().int().nonnegative(),
    // The platform's fleet is full, no machine to give anyone; unrelated to this account's own `remaining`.
    full: z.boolean().optional(),
    hours: HostedHoursSchema.optional(),
    // True when the caller is on the hosted plan (or comped): their machines are never removed for going unopened.
    plan: z.boolean().optional(),
    // True when the hosted lane is switched off for this account (hosted-standing.ts); `remaining` is 0 with it.
    suspended: z.boolean().optional(),
    // True when a machine of ours can hold a project folder (`hostedProvision`'s `project`). Absent from a platform from
    // before hosted projects, which would drop that field unread, so the editor keeps a project on the reader's own
    // computer there.
    projects: z.boolean().optional(),
    // True when this account signs in only by email and holds no free paid slot: a free machine, the trial and Repair
    // need a Google sign-in linked to the account first (api sandbox/hosted/free-lane.ts), so the editor offers linking
    // Google, buying a machine, or running the sandbox on the reader's own computer. `remaining` is 0 with it.
    needsGoogle: z.boolean().optional(),
});
export type HostedOffer = z.infer<typeof HostedOfferSchema>;

// The `data.reason` a refusal carries when the free hosted lane (or the trial, or Repair) needs a Google sign-in linked to
// an account that signs in only by email.
export const GOOGLE_REQUIRED_REASON = "google-required";

// Whether this platform can give a sandbox its own address, the tunnel fabric behind `setupCode`.
// A platform with none mints no codes; the wizard must say so before drawing the pasted-command lane.
export const AddressOfferSchema = z.object({ enabled: z.boolean() });

// A short-lived signed claim spent on a hosted daemon; the platform sign-in is the only one needed. Minted only for the
// owner on a platform-run machine; elsewhere it 404s and the browser falls back to Google. The minted ticket as the
// browser carries it, where sandbox-contract's `OwnerTicket` is the claim a daemon decodes from it.
export const MintedOwnerTicketSchema = z.object({
    ticket: z.string(),
    // ISO, the moment the ticket stops verifying; the browser spends it at once and never stores it.
    expiresAt: z.string(),
});
export type MintedOwnerTicket = z.infer<typeof MintedOwnerTicketSchema>;

// The platform's signed word that the caller controls their address, for one sandbox they own or were invited to
// (sandbox-contract policy/identity-assertion.ts). The editor asks for one for an account that signs in by email; the
// daemon decides whether it opens anything (the person's opt-in on a sandbox on its owner's machine, the roster
// everywhere).
export const MintedIdentityAssertionSchema = z.object({
    assertion: z.string(),
    // ISO, the moment it stops verifying; the browser spends it at once and never stores it.
    expiresAt: z.string(),
});
export type MintedIdentityAssertion = z.infer<typeof MintedIdentityAssertionSchema>;
export type AddressOffer = z.infer<typeof AddressOfferSchema>;

// What the registry holds of a sandbox named by its 12-hex id (the `sandboxId` its daemon's /health reports), for the
// editor's recovery: `yours` the caller's own row, `other` another account's (a share that left the list included),
// `deleted` a deletion record, `unknown` neither, which is how a registry that forgot a sandbox answers. Only an
// `unknown` sandbox can be adopted.
export const SandboxStandingSchema = z.enum(["yours", "other", "deleted", "unknown"]);
export type SandboxStanding = z.infer<typeof SandboxStandingSchema>;

export const SandboxLookupSchema = z.object({
    // In the order asked, ids that are not 12-hex dropped; `id` is the caller's row id, on `yours` only.
    sandboxes: z.array(z.object({ sandboxId: z.string(), standing: SandboxStandingSchema, id: z.string().optional() })),
});
export type SandboxLookup = z.infer<typeof SandboxLookupSchema>;

// The owner's say-so for one sandbox's adoption, carried opaque by the browser to the daemon and by the daemon to
// POST /sandbox/adopt; short-lived like the owner ticket.
export const AdoptionTicketSchema = z.object({
    ticket: z.string(),
    // ISO, the moment it stops verifying.
    expiresAt: z.string(),
});
export type AdoptionTicket = z.infer<typeof AdoptionTicketSchema>;

export const SandboxSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    daemonUrl: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    setupCodeClaimedAt: z.string().nullable(),
    // The machine-side setup run's last word, null until a report lands, cleared on every mint.
    setupReport: SetupReportSchema.nullable(),
    // The daemon's own last word on its boot, null until it reports; every lane, not only hosted.
    bootReport: BootReportSchema.nullable(),
    // The last check-in refused, and why; null in the common case, cleared once an announce succeeds.
    announceRefusal: AnnounceRefusalSchema.nullable(),
    /* WHEN THE CONTAINER WAS DELETED, and by which machine — reported by the removal itself, null for every sandbox that was not removed. */
    removedAt: z.string().nullable(),
    removedBy: z.string().nullable(),
    /* THE CONNECT TOKEN, on the OWNER's row only; null on a member's. */
    token: z.string().nullable(),
    // The caller's trust tier on this sandbox: `owner` for their own, the invite's granted role for a shared
    // one. What the web gates its affordances on; the daemon independently enforces the same tier as route
    // floors, so this is a rendering fact, never the security boundary.
    role: MemberRoleSchema,
    providedAddress: z.boolean(),
    // Loopback listener's certified name, or null; server-computed, since it's a different zone from the sandbox.
    localHostname: z.string().nullable(),
    // The hosted lane's machine placement, null off-platform. An asleep machine wakes when selected or retried.
    hosted: SandboxHostedSchema.nullable(),
    // The version the sandbox's daemon named in its last check-in, which is what the platform knows it runs even
    // while it is down. Null until a daemon that names its version checks in; absent from an older platform.
    daemonVersion: z.string().nullable().optional(),
    // What the edge in front of `daemonUrl` DECLARES it serves beyond HTTPS over TCP (`quic`, `h3`, `webtransport`,
    // browser-wire.ts `EdgeTransport`), read off the edge's own /health. Absent from an older platform, off-platform and
    // wherever the edge declares nothing, and absent means not served: the editor opens WebTransport only where it is
    // named. Strings, not an enum, so a token a later edge adds never fails an older editor's parse.
    edgeTransports: z.array(z.string()).optional(),
    // What the machine this sandbox runs on last reported of it (`HostReportSchema`), on the owner's row of an
    // own-machine sandbox only; null until one lands, absent from an older platform. Its `at` says how old it is: the
    // editor reads one older than the outage it is explaining as silence, never as the machine's word.
    hostReport: HostReportSchema.nullable().optional(),
    // (2026-10-05) The newest report of each machine and environment that reported (at most three), newest first, on
    // the same rows as `hostReport`, which is the first of them. Absent from an older platform.
    hostReporters: z.array(HostReportSchema).optional(),
    // (2026-10-05) Two copies of this sandbox announcing side by side (`DuplicateCopiesSchema`), on the owner's row;
    // null while one copy announces alone, absent from an older platform.
    duplicateCopies: DuplicateCopiesSchema.nullable().optional(),
});
export type SandboxSummary = z.infer<typeof SandboxSummarySchema>;

// Days a deleted sandbox stays recoverable, platform and machine alike; `ic` (trash.rs) compiles in this integer literal.
export const SANDBOX_RECOVERY_DAYS = 7;

/* A sandbox the owner deleted, for as long as the delete can still be taken back. Carries no address, token or
 * role: a row here is not a sandbox anyone can reach, only one they can have again. */
export const TrashedSandboxSchema = z.object({
    /** The trash row's own id — NOT the deleted sandbox's, which died with it and is never reissued. */
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    deletedAt: z.string(),
    /** When the data behind this goes for good. */
    purgeAfter: z.string(),
    /** Whether restoring brings a machine and its disk back, or only the name and a setup to re-run. */
    hosted: z.boolean(),
});

export type TrashedSandbox = z.infer<typeof TrashedSandboxSchema>;

/* THE OWNER'S SPENDING CAPS on the platform's wallet signer (api wallet/), written over a SESSION and nowhere else. */
export const WalletPolicySchema = z.object({
    network: WalletNetworkSchema,
    perPaymentMaxUsd: z.string().regex(/^\d+(\.\d{1,6})?$/),
    dailyCapUsd: z.string().regex(/^\d+(\.\d{1,6})?$/),
});
export type WalletPolicy = z.infer<typeof WalletPolicySchema>;

// The sandbox's public base URL as the OWNER asserts it (sandbox.attach) instead of the daemon announcing it,
// the "I already run my sandbox behind a domain that works" path, where nothing ever phones home. https only:
// the web app is served over HTTPS, so a browser blocks every call to an http:// daemon as mixed content.
// Trailing slashes are dropped because each daemon call appends an absolute path (`${daemonUrl}/health`); a
// path prefix is kept, so a sandbox served under `https://example.com/sandbox` works behind the user's proxy.
export const DaemonUrlSchema = z
    .string()
    .max(255)
    .transform((value) => value.trim().replace(/\/+$/, ``))
    .refine((value) => {
        try {
            return new URL(value).protocol === "https:";
        } catch {
            return false;
        }
    }, "must be an https:// URL");

// ---- invites: sharing a sandbox with teammates by email ----

// A row in the owner's access roster: an email plus its derived state.
//   pending invited, link not yet accepted
//   accepted an active member
//   expired the link lapsed unaccepted (owner can resend)
// `expiresAt` is absent once accepted, or when there is none.
export const InviteStatusSchema = z.enum(["pending", "accepted", "expired"]);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export const InviteRecordSchema = z.object({
    email: z.string(),
    // The trust tier granted (never owner); the daemon's list is the enforced copy, this is what re-grades from.
    role: GrantedRoleSchema,
    status: InviteStatusSchema,
    invitedAt: z.string(),
    expiresAt: z.string().optional(),
});
export type InviteRecord = z.infer<typeof InviteRecordSchema>;
export const InviteListSchema = z.object({ members: z.array(InviteRecordSchema) });

// How the invite link travelled; the grant is already made, so delivery never decides the mutation's verdict.
// The rest are this platform declining or failing to send, so `link` always comes back to hand over.
export const InviteDeliverySchema = z.enum(["sent", "unconfigured", "local-link", "refused"]);
export type InviteDelivery = z.infer<typeof InviteDeliverySchema>;
export const InviteSentSchema = z.object({
    members: z.array(InviteRecordSchema),
    // The accept link just minted, for the owner to hand over when mail didn't carry it.
    link: z.string(),
    delivery: InviteDeliverySchema,
    // What the mail provider said on refusal, verbatim-ish; `refused` only, fixable by whoever reads the card.
    reason: z.string().optional(),
});

// What the public accept page renders from a token, no session needed.
// `invalid` means no such token; name/email are included otherwise, so the page can prompt the right account.
export const InvitePreviewStatusSchema = z.enum(["pending", "accepted", "expired", "invalid"]);
export const InvitePreviewSchema = z.object({
    status: InvitePreviewStatusSchema,
    sandboxName: z.string().optional(),
    invitedEmail: z.string().optional(),
    // The tier the link carries, so the accept page can say what's being accepted; absent on an invalid token.
    role: GrantedRoleSchema.optional(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// Zone discovery for the setup picker; a token can see multiple zones, so the user picks one first.
// Request-scoped: used for one Cloudflare listing call (the browser can't, no CORS) and then discarded.
export const CfTokenSchema = z.object({ token: z.string().min(1) });
export const CfZonesSchema = z.object({ zones: z.array(z.string()) });
export type CfZones = z.infer<typeof CfZonesSchema>;

// One short-lived value the install command carries, so no raw token lands in shell history.
// Redeemed at /setup/claim for a connect token and reachability grant; the address is derived, not chosen.
export const SetupCodeSchema = z.object({ code: z.string(), hostname: z.string(), expiresAt: z.string() });
export type SetupCode = z.infer<typeof SetupCodeSchema>;

// A "view" is a projection of the desired-state graph plus reconciliation drift.
// Read through the sandbox's own git routes (desired-state.json + status.json); it stays the source of truth.
// Only non-secret scalar inputs are surfaced; $secret/$ref values are dropped upstream.

// Coarse lenses the closed resource-type vocabulary buckets into, for grouping in the Overview.
export const ResourceGroupSchema = z.enum(["infra", "git", "deploy", "data", "notify", "other"]);
export type ResourceGroup = z.infer<typeof ResourceGroupSchema>;

// Maps each resource type to its group; a typed Record, so a new kind with no bucket is a compile error.
const RESOURCE_GROUP: Record<ResourceType, ResourceGroup> = {
    host: "infra",
    cloudflare: "infra",
    tunnel: "infra",
    "cf-route": "infra",
    forgejo: "git",
    "forgejo-user": "git",
    "forgejo-org": "git",
    "forgejo-team": "git",
    "forgejo-runner": "git",
    repo: "git",
    "control-repo": "git",
    ci: "git",
    github: "git",
    "gh-repo": "git",
    "gh-ci": "git",
    gitlab: "git",
    "gl-repo": "git",
    "gl-ci": "git",
    komodo: "deploy",
    "komodo-periphery": "deploy",
    "komodo-server": "deploy",
    "komodo-user": "deploy",
    deployment: "deploy",
    postgres: "data",
    "postgres-database": "data",
    valkey: "data",
    "valkey-namespace": "data",
    signoz: "data",
    authentik: "data",
    "authentik-client": "data",
    garage: "data",
    "garage-bucket": "data",
    discord: "notify",
    "forgejo-notify": "notify",
    "komodo-notify": "notify",
    stripe: "other",
    outline: "other",
    paperless: "other",
    openproject: "other",
    invoiceninja: "other",
    infisical: "other",
    workspace: "other",
    backup: "other",
};

// The coarse group for a resource type; a string outside the closed vocabulary falls to "other".
export const groupOf = (type: string): ResourceGroup => RESOURCE_GROUP[type as ResourceType] ?? "other";

export const ResourceViewSchema = z.object({
    id: z.string(),
    // The resolver's closed kind vocabulary (host/forgejo/komodo/deployment/…), kept open here as a string.
    type: z.string(),
    title: z.string(),
    group: ResourceGroupSchema,
    // The service's public URL when derivable from a `domain`/`hostname` input, for deep-linking out.
    url: z.string().optional(),
    dependsOn: z.array(z.string()),
    // Non-secret scalar inputs only (string | number | boolean); secrets/refs are dropped.
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    // The per-resource reconcile action from status.json, or "unknown" before the first apply or if absent.
    status: z.string(),
    // The human-readable drift cause from status.json's step; present for "update" steps only.
    reason: z.string().optional(),
});
export type ResourceView = z.infer<typeof ResourceViewSchema>;

// Where the user logs into a provisioned service, from status.json's value-free access entries.
// A generated password's value is fetched via the owner-gated /secrets/reveal, keyed by `password.key`.
export const AccessEntrySchema = z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    username: z.string().optional(),
    password: z.object({ source: z.enum([`env`, `generated`]), key: z.string() }).optional(),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

export const WorkspaceStateSchema = z.object({
    resources: z.array(ResourceViewSchema),
    // From status.json (the last `intentic deploy apply`); undefined before the first apply.
    converged: z.boolean().optional(),
    iterations: z.number().optional(),
    access: z.array(AccessEntrySchema).optional(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

// Live Komodo deployments from `intentic deploy deployments`, confirmed live against the Komodo API.
// `env` carries only non-secret values; runtime detail lives in Komodo's own UI via `komodoDeploymentUrl`.
export const DeploymentSchema = z.object({
    // The graph node id (e.g. "app.production"), also the Komodo deployment name.
    name: z.string(),
    // The registry image CI pushes and Komodo runs: registry/owner/repo:tag.
    image: z.string(),
    tag: z.string(),
    domain: z.string().optional(),
    url: z.string().optional(),
    port: z.number().optional(),
    env: z.record(z.string(), z.string()),
    // Whether Komodo currently has this deployment registered (login + ListDeployments matched it).
    live: z.boolean(),
    komodoUrl: z.string(),
    komodoDeploymentUrl: z.string().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

// Push relay: Apple and Firebase only accept pushes from the app's own vendor, so a native install can't be posted to
// directly. The daemon posts sessionless, proven by its per-device secret; each side holds only the half it needs.

// ios: the editor's iPhone app, notified through APNs. android: an app on a phone, reached through FCM with a data-only
// message that never carries the title or the body; which app says what that message is (PushAppSchema).
export const PushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

// Which Android app holds the token. device: the Intentic Device app, WOKEN (`kind: "wake"`, it dials its sandbox and
// shows nothing). editor: the native editor app (dev.intentic.app), told `kind: "notify"` with only the tag, the in-app
// path and the sandbox, and it fetches the words from the daemon itself. iOS has one app, the editor, and ignores this.
export const PushAppSchema = z.enum(["device", "editor"]);
export type PushApp = z.infer<typeof PushAppSchema>;

export const PushDeviceInputSchema = z.object({
    platform: PushPlatformSchema,
    // The APNs device token as the shell reports it (hex), or the phone app's FCM registration token; opaque here, only
    // the forwarder interprets it.
    token: z.string().min(1).max(400),
    // Absent is `device`, what every Android registration meant before the editor app existed.
    app: PushAppSchema.optional(),
    // Which sandbox this registration is for, handed back in every notify so the app knows which daemon to ask; the relay
    // stores it and never interprets it. One row per (token, sandbox), so re-registering for one sandbox rotates only that
    // sandbox's secret. Absent, the token has a single row that every sandbox it is subscribed on shares, as iOS and the
    // Device app have.
    sandbox: z.string().min(1).max(200).optional(),
});

// What a registration answers: the relay channel the web app stores on the daemon.
// `secret` is returned once and persisted only as a hash; `url` is absolute, so grants always point home.
export const PushDeviceGrantSchema = z.object({
    deviceId: z.string(),
    secret: z.string(),
    url: z.url(),
});
export type PushDeviceGrant = z.infer<typeof PushDeviceGrantSchema>;

// A daemon's send; the notification is the daemon's own wire shape, forwarded unchanged.
export const PushSendSchema = z.object({
    deviceId: z.string().min(1),
    secret: z.string().min(1),
    notification: PushNotificationSchema,
});

// Whether APNs or FCM took the send; lets the settings page's test button prove the chain end-to-end.
export const PushSentSchema = z.object({ delivered: z.boolean() });

/* ACCOUNT-LEVEL API TOKENS (api tokens/): the credential that acts for a person outside a browser. */

// The scopes a token may carry. `provision` is held by a sandbox's `fleet` capability so an agent in it can create
// sandboxes for the owner; it cannot read a sandbox, spend the hosted plan, or mint another token.
export const ApiTokenScopeSchema = z.enum([`provision`]);
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>;

// A token as the Tokens page lists it. No value and no digest: the raw one was shown once at mint, and the digest is
// a lookup key, not something a reader can do anything with.
export const ApiTokenSchema = z.object({
    id: z.string(),
    label: z.string(),
    scope: ApiTokenScopeSchema,
    createdAt: z.string(),
    // Absent until something presents it; coarse to the minute, so it answers "is this one in use" and nothing finer.
    lastUsedAt: z.string().optional(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

// The mint's answer, and the only time `token` exists anywhere but the holder's hands: it is stored as a digest, so a
// value not copied now is replaced rather than recovered.
export const ApiTokenMintedSchema = ApiTokenSchema.extend({ token: z.string() });
export type ApiTokenMinted = z.infer<typeof ApiTokenMintedSchema>;
