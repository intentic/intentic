import { randomBytes } from "node:crypto";
import { apiContract, SandboxCloudSchema, SetupReportSchema } from "@intentic-app/api-contract";
import { Prisma } from "@intentic-app/prisma";
import type { MemberRole } from "@intentic/sandbox-contract";
import { GrantedRoleSchema, sandboxSubdomain } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { CloudCredentialError, CloudProviderError } from "./cloud/common.js";
import { cloudCreate, cloudOptions } from "./cloud/index.js";
import { cloudInitUserData } from "./cloud/user-data.js";
import { CloudflareTokenError, listZoneNames } from "./cloudflare.js";
import { destroyHosted, hostedEnabled, provisionHosted, wakeHosted } from "./hosted/hosted.js";
import { hostedRegionFor } from "./hosted/region.js";
import { sendSetupLinkEmail } from "./setup-email.js";
import { ensureZrokAccount, zrokEnabled } from "./zrok-provision.js";
import { deleteSandboxAccount } from "./zrok.js";

const os = implement(apiContract).$context<OrpcContext>();

// How long a minted setup code stays claimable. Long enough to install Docker mid-run and retry a failed
// command; short enough that a leaked pasted command goes stale quickly.
const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

// The hub's zone when the tunnel fabric is configured, else undefined — the zone alone defaults even when
// the fabric is off, so it must not flag sandboxes on its own.
const intenticZoneOf = (context: OrpcContext): string | undefined => (zrokEnabled(context.config) ? context.config.zrok.zone : undefined);

// Shape a sandbox row for the browser. `role` is the caller's relationship — owner rows drive management, member
// rows are access-only. token + daemonUrl are what the browser needs to reach the daemon directly (the stored
// token is encrypted at rest, so it is decrypted here); daemonUrl + lastSeenAt come from the daemon's announce.
// `providedTunnel` flags a daemonUrl under the platform's own tunnel zone — the browser reads it to tell a
// sandbox we made reachable from one the owner attached behind a domain of their own.
// `setupCodeClaimedAt` rides along for the setup wizard: it is the platform's only evidence that the pasted
// command reached a machine, and the wizard's wait reads very differently before and after it.
const toSummary = (
    sandbox: {
        id: string;
        name: string;
        image: string | null;
        daemonUrl: string | null;
        lastSeenAt: Date | null;
        setupCodeClaimedAt: Date | null;
        setupReport: unknown;
        cloud: unknown;
        // The hosted lane's machine record — every query feeding this summary includes the relation, so a
        // rename or an announce can never silently strip the hosted badge from the browser's row. Optional
        // (not just nullable) as the same shield the report parse below gives rows from before a schema
        // existed: a caller that skipped the include reads as "not hosted", never as a crash.
        hosted?: { region: string } | null;
        token: string;
    },
    role: MemberRole,
    context: OrpcContext,
) => {
    const zone = intenticZoneOf(context);
    // The stored report was validated on write (/setup/report); the parse here only shields the summary from
    // rows written before this schema existed — anything unrecognizable reads as "no report".
    const report = SetupReportSchema.safeParse(sandbox.setupReport);
    // Same shield for the cloud stamp (cloudProvision wrote it validated; the stored serverId is dropped by
    // the parse — the browser has no use for it).
    const cloud = SandboxCloudSchema.safeParse(sandbox.cloud);
    return {
        id: sandbox.id,
        name: sandbox.name,
        image: sandbox.image,
        daemonUrl: sandbox.daemonUrl,
        lastSeenAt: sandbox.lastSeenAt === null ? null : sandbox.lastSeenAt.toISOString(),
        setupCodeClaimedAt: sandbox.setupCodeClaimedAt === null ? null : sandbox.setupCodeClaimedAt.toISOString(),
        setupReport: report.success ? report.data : null,
        cloud: cloud.success ? cloud.data : null,
        hosted: sandbox.hosted === null || sandbox.hosted === undefined ? null : { region: sandbox.hosted.region },
        token: decryptSecret(context.config, sandbox.token),
        role,
        providedTunnel: sandbox.daemonUrl !== null && zone !== undefined && new URL(sandbox.daemonUrl).hostname.endsWith(`.${zone}`),
    };
};

export const sandboxRoutes = {
    // Every sandbox the caller owns or has been granted access to (by email), owned first. The single read the
    // browser needs — token + daemonUrl included so it can reach each daemon directly.
    list: os.sandbox.list.handler(async ({ context }) => {
        const user = requireUser(context);
        const [owned, memberships] = await Promise.all([
            context.prisma.sandbox.findMany({ where: { ownerId: user.id }, include: { hosted: true }, orderBy: { createdAt: `asc` } }),
            // Only ACCEPTED memberships surface a shared sandbox — a pending invite must not reveal it before
            // the invitee accepts. Lowercased to match how invites are stored (and how the daemon verifies).
            // Queried through the membership row (not `some`) because the row carries the caller's ROLE.
            context.prisma.sandboxMember.findMany({
                where: { email: user.email.toLowerCase(), acceptedAt: { not: null } },
                include: { sandbox: { include: { hosted: true } } },
                orderBy: { sandbox: { createdAt: `asc` } },
            }),
        ]);
        return {
            sandboxes: [
                ...owned.map((sandbox) => toSummary(sandbox, `owner`, context)),
                // Same safety net as toInviteRecord: an unknown stored word degrades to the safest tier.
                ...memberships.map((membership) => toSummary(membership.sandbox, GrantedRoleSchema.catch(`viewer`).parse(membership.role), context)),
            ],
        };
    }),
    // Mint a new sandbox for the caller. Unlimited — own as many as you like. Nothing is provisioned here:
    // a zrok account is one fast call the first setup mint (or hosted provision) makes, which is why the
    // pre-provisioned pool the Cloudflare tunnels needed died with them.
    create: os.sandbox.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const token = randomBytes(16).toString(`base64url`);
        const sandbox = await context.prisma.sandbox.create({
            data: { name: input.name, ownerId: user.id, token: encryptSecret(context.config, token), tokenDigest: sha256Hex(token) },
            include: { hosted: true },
        });
        return toSummary(sandbox, `owner`, context);
    }),
    // Rename an owned sandbox and/or set its switcher logo (a small data URL the browser produced) — `null`
    // clears the logo back to the monogram. The `!== undefined` guards are what keep the two fields
    // independent: a rename must not blank a logo, and clearing a logo must not rename anything.
    update: os.sandbox.update.handler(async ({ context, input }) => {
        await requireOwnedSandbox(context, input.sandboxId);
        const sandbox = await context.prisma.sandbox.update({
            where: { id: input.sandboxId },
            data: { ...(input.name !== undefined && { name: input.name }), ...(input.image !== undefined && { image: input.image }) },
            include: { hosted: true },
        });
        return toSummary(sandbox, `owner`, context);
    }),
    // Remove an owned sandbox (cascades its member grants), its hosted machine, and its reachability grant on
    // the hub — the platform destroys everything it provisioned. The grant is revoked FIRST and the machine is
    // destroyed after the row, and the asymmetry is the hubs' own doing: Fly apps can be listed by prefix, so
    // a machine the teardown missed is found and destroyed tomorrow, while zrok v2 has no way to list accounts
    // at all — a grant whose row is gone could never be found again. So the removal fails on a hub hiccup and
    // the user retries, rather than stranding an address nobody can revoke. The daemon keeps running on its
    // host until cleanup.sh tears it down there.
    delete: os.sandbox.delete.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        // Read the hosted record BEFORE the row goes — the cascade takes it, and its appName is the teardown.
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: input.sandboxId } });
        if (sandbox.zrokToken !== null && zrokEnabled(context.config)) {
            const sandboxId = sandboxIdFromToken(decryptSecret(context.config, sandbox.token)) ?? sandbox.id;
            try {
                await deleteSandboxAccount(context.config.zrok, sandboxId);
            } catch (error) {
                context.logger.error({ err: error, sandboxId: input.sandboxId }, `zrok account teardown failed`);
                throw new ORPCError(`BAD_GATEWAY`, { message: `couldn't take this sandbox's address down just now — try removing it again in a moment` });
            }
        }
        await context.prisma.sandbox.delete({ where: { id: input.sandboxId } });
        // A hosted sandbox's machine dies with it, best-effort AFTER the row: the row is what the browser
        // reads, so a slow provider would otherwise keep a just-removed sandbox on screen — and a failed
        // teardown leaves an app with no row, which is exactly what the hosted reaper destroys tomorrow.
        if (hosted !== null) {
            try {
                await destroyHosted(context.config, hosted.appName);
            } catch (error) {
                context.logger.warn({ err: error, sandboxId: input.sandboxId, app: hosted.appName }, `hosted machine teardown failed; orphaned for the reaper`);
            }
        }
        return { ok: true };
    }),
    // Drop the caller's OWN member grant — a member removing a shared sandbox from their account. The sandbox,
    // its owner, and the daemon are untouched (the daemon's authorized list stays owner-pushed, like delete).
    // Idempotent; lowercased to match how share stores grants.
    leave: os.sandbox.leave.handler(async ({ context, input }) => {
        const user = requireUser(context);
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: input.sandboxId, email: user.email.toLowerCase() } });
        return { ok: true };
    }),
    // The zones a pasted Cloudflare token can see — the in-app Cloudflare capability's credential check (the
    // user's OWN zone, for the deploy engine's apps). Nothing to do with sandbox reachability, which the
    // self-hosted hub serves. Session-gated, used for this one call, then dropped — never persisted or logged.
    zones: os.sandbox.zones.handler(async ({ context, input }) => {
        requireUser(context);
        try {
            return { zones: await listZoneNames(input.token) };
        } catch (error) {
            if (error instanceof CloudflareTokenError) {
                throw new ORPCError(`BAD_REQUEST`, { message: error.message });
            }
            throw error;
        }
    }),
    // The cloud lane's credential check + catalog: spend the pasted provider credential on the provider's own
    // region/size/price listing (cloud/index.ts), then drop it with the request — the `zones` contract. Both
    // named refusals become BAD_REQUESTs the wizard can render; anything else (network, surprise shapes)
    // propagates like every other handler's unexpected failure.
    cloudOptions: os.sandbox.cloudOptions.handler(async ({ context, input }) => {
        requireUser(context);
        try {
            return await cloudOptions(input.credentials);
        } catch (error) {
            if (error instanceof CloudCredentialError || error instanceof CloudProviderError) {
                throw new ORPCError(`BAD_REQUEST`, { message: error.message });
            }
            throw error;
        }
    }),
    /* Create the ONE machine in the user's own cloud account whose first boot runs this sandbox's setup code
     * (cloud/user-data.ts). Requires a LIVE intentic-mode code: the machine boots headless with no Cloudflare
     * of its own, so only the platform-provisioned tunnel can make it reachable — and a dead code would build
     * a machine that boots to a 404. The wizard mints (its lane defaults to intentic mode) before calling
     * this, so the gate only fires on a stale tab.
     *
     * The credential is request-scoped here exactly as in cloudOptions — after this response the platform
     * cannot reach the machine again, which is why the non-secret residue (provider, server name, location)
     * is stamped on the row: it is everything the UI can ever say about where the machine lives. The server
     * name is derived from the tunnel id, so the machine in the provider's console visibly matches the
     * sandbox-<id> hostname the user already sees. */
    cloudProvision: os.sandbox.cloudProvision.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        if (sandbox.setupCode === null || sandbox.setupCodeExpiresAt === null || sandbox.setupCodeExpiresAt < new Date()) {
            throw new ORPCError(`BAD_REQUEST`, { message: `this sandbox has no live setup code — reopen its setup screen and retry` });
        }
        const payload =
            typeof sandbox.setupPayload === `string`
                ? (JSON.parse(decryptSecret(context.config, sandbox.setupPayload)) as Record<string, string>)
                : {};
        if (payload[`SANDBOX_HOSTNAME`] === undefined) {
            throw new ORPCError(`BAD_REQUEST`, {
                message: `the setup code targets your own Cloudflare — cloud machines need the intentic-provided tunnel`,
            });
        }
        const connectToken = decryptSecret(context.config, sandbox.token);
        const name = `intentic-${sandboxSubdomain(sandboxIdFromToken(connectToken) ?? sandbox.id)}`;
        const userData = cloudInitUserData({
            scriptOrigin: context.config.scriptOrigin,
            platformUrl: context.config.api.url,
            setupCode: sandbox.setupCode,
        });
        let serverId: string;
        try {
            serverId = (await cloudCreate(input.credentials, { name, location: input.location, size: input.size, userData })).serverId;
        } catch (error) {
            if (error instanceof CloudCredentialError || error instanceof CloudProviderError) {
                throw new ORPCError(`BAD_REQUEST`, { message: error.message });
            }
            // Surface WHY like setupCode's tunnel provisioning — a raw throw serializes as a bare
            // "Internal server error" in the wizard.
            if (error instanceof Error) {
                throw new ORPCError(`BAD_GATEWAY`, { message: error.message });
            }
            throw error;
        }
        const updated = await context.prisma.sandbox.update({
            where: { id: sandbox.id },
            data: { cloud: { provider: input.credentials.provider, serverId, serverName: name, location: input.location } },
            include: { hosted: true },
        });
        return toSummary(updated, `owner`, context);
    }),
    // The hosted lane's front door: whether this platform runs sandboxes at all, and how many more the caller
    // may create under the per-user allowance. The editor's zero-click first run and the wizard's lead card
    // both read this before offering anything.
    hostedOffer: os.sandbox.hostedOffer.handler(async ({ context }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            return { enabled: false, remaining: 0 };
        }
        const used = await context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: user.id } } });
        return { enabled: true, remaining: Math.max(0, context.config.hosted.perUser - used) };
    }),
    /* Give an existing sandbox a machine on intentic's own provider — the lane with no command, no code, no
     * paste. Shaped after cloudProvision on purpose: the ROW is created the ordinary way on arrival, and
     * choosing this lane moves a MACHINE, never the sandbox, so the wizard can switch lanes without losing
     * the name and address the user already has.
     *
     * The tunnel comes first (already claimed from the pool by `create`, else provisioned here) because the
     * machine env must carry the connector token and public URL; then the machine is created and the daemon's
     * ordinary announce narrates the rest to the waiting browser, exactly as a pasted run's does. OWNER_EMAIL
     * seeds the daemon's first-bind exactly like setupCode's payload: only this Google identity may bind.
     *
     * Idempotent — a sandbox that already has a machine answers with itself rather than growing a second one,
     * so a double-click or a retry after a slow response costs nothing. A FAILURE leaves the sandbox exactly
     * as it found it (provisionHosted cleans up its own half-made app), which is what lets the wizard say
     * what went wrong and stay on a working row instead of starting the user over. */
    hostedProvision: os.sandbox.hostedProvision.handler(async ({ context, input }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `hosted sandboxes are not enabled on this platform` });
        }
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const existing = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (existing !== null) {
            const already = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
            return toSummary(already, `owner`, context);
        }
        const used = await context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: user.id } } });
        if (used >= context.config.hosted.perUser) {
            throw new ORPCError(`BAD_REQUEST`, {
                message: `you already have ${used === 1 ? `a sandbox we host` : `${used} sandboxes we host`} — remove one to have this sandbox hosted instead`,
            });
        }
        if (!zrokEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `this platform has no tunnel fabric configured` });
        }
        let grant;
        try {
            // The machine's env must carry the sandbox's reachability grant, so it is minted (or reused)
            // before the machine exists — the same ordering the tunnel had, one call instead of a dozen.
            grant = await ensureZrokAccount(context.prisma, context.config, sandbox);
        } catch (error) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `provisioning reachability failed` });
        }
        try {
            await provisionHosted(context.prisma, context.config, context.logger, {
                sandboxId: sandbox.id,
                connectToken: decryptSecret(context.config, sandbox.token),
                grant,
                ownerEmail: user.email.toLowerCase(),
                region: hostedRegionFor(context.config.hosted, context.headers),
            });
        } catch (error) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `creating the hosted machine failed` });
        }
        const fresh = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
        return toSummary(fresh, `owner`, context);
    }),
    /* The way back out of the hosted lane: destroy the machine, keep the sandbox. This is the wizard's
     * lane-switch (someone tries "we host it", then decides to run it on their own machine after all), which
     * is why it is deliberately narrow — a sandbox that has EVER connected is a workspace with a person's
     * files on it, and destroying its machine belongs to the delete dialog and the confirmation it shows,
     * never to a card being clicked. Idempotent: no machine is a no-op, not an error. */
    hostedRelease: os.sandbox.hostedRelease.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (hosted !== null) {
            if (sandbox.lastSeenAt !== null) {
                throw new ORPCError(`BAD_REQUEST`, {
                    message: `this sandbox has already started — remove it from your account to destroy the machine we run for it`,
                });
            }
            try {
                await destroyHosted(context.config, hosted.appName);
            } catch (error) {
                throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `destroying the machine failed` });
            }
            await context.prisma.hostedMachine.delete({ where: { sandboxId: sandbox.id } });
        }
        const fresh = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
        return toSummary(fresh, `owner`, context);
    }),
    // Power a hosted sandbox's machine back on — the idle-stop's other half, called by any browser (owner or
    // accepted member) that finds the daemon unreachable. Idempotent: waking a running machine is a no-op, so
    // the browser needs no machine-state oracle, it just wakes and keeps probing the daemon like always.
    wake: os.sandbox.wake.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await context.prisma.sandbox.findFirst({
            where: {
                id: input.sandboxId,
                OR: [{ ownerId: user.id }, { members: { some: { email: user.email.toLowerCase(), acceptedAt: { not: null } } } }],
            },
            include: { hosted: true },
        });
        if (!sandbox || sandbox.hosted === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
        }
        try {
            await wakeHosted(context.config, sandbox.hosted);
        } catch (error) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `waking the machine failed` });
        }
        return { ok: true };
    }),
    /* Mint the short-lived setup code the install one-liner carries instead of raw tokens. One lane now: the
     * sandbox's reachability grant on the self-hosted hub is minted (or reused) here and stashed in the
     * payload, so the pasted command carries a code and nothing else — the address it will answer on is a
     * derivation of the connect token, known before anything runs. Re-claimable until expiry so a failed run
     * stays re-runnable; re-minting overwrites the previous code but never the grant. */
    setupCode: os.sandbox.setupCode.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        if (!zrokEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `this platform has no tunnel fabric configured` });
        }
        let grant;
        try {
            grant = await ensureZrokAccount(context.prisma, context.config, sandbox);
        } catch (error) {
            // Surface WHY — a raw throw serializes as a bare "Internal server error" in the wizard.
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `provisioning reachability failed` });
        }
        const hostname = grant.hostname;
        const payload: Record<string, string> = {
            ZROK_TOKEN: grant.accountToken,
            ZROK_API: grant.apiEndpoint,
            ZROK_NAMESPACE: grant.namespaceToken,
            SANDBOX_HOSTNAME: hostname,
        };
        // Seed the creator's account email so the daemon binds ONLY this Google identity as owner (TOFU by
        // the intended person, not just whoever holds the connect token) — daemon ownership then always
        // matches the intentic account. Lowercased to match the daemon's case-insensitive owner check.
        payload[`OWNER_EMAIL`] = user.email.toLowerCase();
        const code = randomBytes(8).toString(`base64url`);
        const expiresAt = new Date(Date.now() + SETUP_CODE_TTL_MS);
        // The claim stamp belongs to the code, so a fresh code starts unclaimed. Without this, re-minting (the
        // user switches Cloudflare zone, or resumes a sandbox that was connected once before) would leave the
        // wizard reporting "your machine picked this up" about a command that no longer exists.
        await context.prisma.sandbox.update({
            where: { id: sandbox.id },
            data: {
                setupCode: code,
                setupCodeExpiresAt: expiresAt,
                setupCodeClaimedAt: null,
                // A fresh code describes a fresh run — last run's setup report would narrate the wrong one.
                setupReport: Prisma.DbNull,
                setupPayload: encryptSecret(context.config, JSON.stringify(payload)),
            },
        });
        return { code, hostname, expiresAt: expiresAt.toISOString() };
    }),
    /* Mail the owner a link back to this sandbox's setup screen. Owner-only and self-addressed: the recipient is
     * the SESSION's email, never an input, so this can only ever put a link in the requester's own inbox and is
     * no use to anyone as a way to send mail to someone else. What it carries is in setup-email.ts, and the short
     * version is that it carries nothing — the code, the command and the connect token all stay off it.
     *
     * Deliberately NOT plan-gated and NOT rate-limited beyond that: it is the escape hatch on the step where the
     * funnel loses people, its blast radius is one mail to the sender's own address, and the mail costs nothing
     * to ignore. */
    emailSetupLink: os.sandbox.emailSetupLink.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await sendSetupLinkEmail(context.config, context.logger, { to: user.email, sandboxName: sandbox.name, sandboxId: sandbox.id });
        return { ok: true };
    }),
    // Record where a sandbox the user ALREADY runs is reachable — the owner-asserted counterpart to the daemon's
    // POST /sandbox/announce, for a daemon that never phones home (no PLATFORM_URL, or a network that can't
    // reach us). The browser has already probed the URL and been authorized by the daemon before calling this,
    // which is the only verification that means anything: the platform never calls into a sandbox (so it can't
    // check, and probing an arbitrary owner-supplied URL from here would be an SSRF hole). lastSeenAt is stamped
    // like an announce so the wizard's "connected" test and the switcher read it the same way.
    attach: os.sandbox.attach.handler(async ({ context, input }) => {
        await requireOwnedSandbox(context, input.sandboxId);
        const sandbox = await context.prisma.sandbox.update({
            where: { id: input.sandboxId },
            data: { daemonUrl: input.daemonUrl, lastSeenAt: new Date() },
            include: { hosted: true },
        });
        return toSummary(sandbox, `owner`, context);
    }),
};
