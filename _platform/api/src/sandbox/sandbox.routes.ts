import { randomBytes } from "node:crypto";
import { apiContract } from "@intentic-app/api-contract";
import type { MemberRole } from "@intentic/sandbox-contract";
import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { CloudflareTokenError, deleteSandboxTunnel, listZoneNames, provisionSandboxTunnel, sandboxHostname } from "./cloudflare.js";
import { claimReserved, topUp } from "./sandbox-pool.js";
import { sendSetupLinkEmail } from "./setup-email.js";

const os = implement(apiContract).$context<OrpcContext>();

// How long a minted setup code stays claimable. Long enough to install Docker mid-run and retry a failed
// command; short enough that a leaked pasted command goes stale quickly.
const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

// The intentic zone when intentic-provided tunnels are enabled (token + zone configured), else undefined —
// the zone alone defaults even when the feature is off, so it must not flag sandboxes on its own.
const intenticZoneOf = (context: OrpcContext): string | undefined => {
    const { apiToken, zone } = context.config.intenticCloudflare;
    return apiToken !== `` && zone !== `` ? zone : undefined;
};

// Shape a sandbox row for the browser. `role` is the caller's relationship — owner rows drive management, member
// rows are access-only. token + daemonUrl are what the browser needs to reach the daemon directly (the stored
// token is encrypted at rest, so it is decrypted here); daemonUrl + lastSeenAt come from the daemon's announce.
// `providedTunnel` flags a daemonUrl under intentic's own zone, so the infra operator panel mints host tunnels
// via the daemon's connect-token relay (POST /sandbox/host-tunnel) instead of asking for the user's Cloudflare token.
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
        token: string;
    },
    role: MemberRole,
    context: OrpcContext,
) => {
    const zone = intenticZoneOf(context);
    return {
        id: sandbox.id,
        name: sandbox.name,
        image: sandbox.image,
        daemonUrl: sandbox.daemonUrl,
        lastSeenAt: sandbox.lastSeenAt === null ? null : sandbox.lastSeenAt.toISOString(),
        setupCodeClaimedAt: sandbox.setupCodeClaimedAt === null ? null : sandbox.setupCodeClaimedAt.toISOString(),
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
            context.prisma.sandbox.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: `asc` } }),
            // Only ACCEPTED memberships surface a shared sandbox — a pending invite must not reveal it before
            // the invitee accepts. Lowercased to match how invites are stored (and how the daemon verifies).
            // Queried through the membership row (not `some`) because the row carries the caller's ROLE.
            context.prisma.sandboxMember.findMany({
                where: { email: user.email.toLowerCase(), acceptedAt: { not: null } },
                include: { sandbox: true },
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
    // Mint a new sandbox for the caller. Unlimited — own as many as you like.
    create: os.sandbox.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        // Claim a pre-provisioned subdomain when the pool is enabled and stocked (sandbox-pool.ts): its token +
        // intentic tunnel are copied verbatim (already encrypted), so setupCode's tunnelToken is already set and
        // its Cloudflare round-trips are skipped — the wizard's "preparing your domain" step becomes instant.
        // The claimed slot is refilled in the background, never blocking this response.
        const reserved = context.config.intenticCloudflare.poolSize > 0 ? await claimReserved(context.prisma) : undefined;
        if (reserved !== undefined) {
            const sandbox = await context.prisma.sandbox.create({
                data: {
                    name: input.name,
                    ownerId: user.id,
                    token: reserved.token,
                    tokenDigest: reserved.tokenDigest,
                    tunnelToken: reserved.tunnelToken,
                    tunnelHostname: reserved.tunnelHostname,
                },
            });
            void topUp(context.prisma, context.config, context.logger).catch((error) =>
                context.logger.error({ err: error }, `sandbox pool refill after claim failed`),
            );
            return toSummary(sandbox, `owner`, context);
        }
        // Empty pool → mint inline as before; setupCode provisions the tunnel lazily.
        const token = randomBytes(16).toString(`base64url`);
        const sandbox = await context.prisma.sandbox.create({
            data: { name: input.name, ownerId: user.id, token: encryptSecret(context.config, token), tokenDigest: sha256Hex(token) },
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
        });
        return toSummary(sandbox, `owner`, context);
    }),
    // Remove an owned sandbox (cascades its member grants) AND its intentic-provided Cloudflare tunnel + DNS —
    // the platform destroys everything it provisioned (own-CF tunnels are the user's, untouched). The row goes
    // FIRST, and the teardown is best-effort after it: the row is the only thing the browser reads
    // (sandbox.list), while the teardown is a stack of Cloudflare round-trips — tearing down first kept a
    // just-removed sandbox visible to any reload during those seconds, and made every Cloudflare hiccup fail a
    // removal the user already confirmed. A failed teardown just orphans an intentic-owned tunnel, which the
    // daily reaper deletes along with its DNS once the connector detaches (the common case: a host whose
    // cloudflared is still connected refuses the delete with 1022 until cleanup.sh runs there).
    // The daemon keeps running on its host until cleanup.sh tears it down there.
    delete: os.sandbox.delete.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await context.prisma.sandbox.delete({ where: { id: input.sandboxId } });
        if (sandbox.tunnelToken === null) {
            return { ok: true };
        }
        const { apiToken, zone } = context.config.intenticCloudflare;
        try {
            await deleteSandboxTunnel({ apiToken, zone, connectToken: decryptSecret(context.config, sandbox.token) });
        } catch (error) {
            context.logger.warn({ err: error, sandboxId: input.sandboxId }, `sandbox tunnel teardown failed; orphaned for the reaper`);
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
    // List the Cloudflare zones the pasted token can see, so setup can make the user pick one before the install
    // command is revealed. Session-gated, used for this one call, then dropped — never persisted or logged.
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
    // Mint the short-lived setup code the install one-liner carries instead of raw tokens. Per target mode:
    // `intentic` — provision the tunnel + proxied DNS record UP FRONT (cached on the row, so only the first
    // mint per sandbox hits Cloudflare): the wizard binds + probes the hostname the moment this returns, and
    // a probe fired before the DNS record exists gets NXDOMAIN, which resolver chains negative-cache for the
    // zone's SOA TTL (30 min) — the wizard then looks dead long after the sandbox is up. `own` — stash the
    // zone/subdomain picks (the user's CF token NEVER enters the code — it rides the command as an env var;
    // that path's tunnel is created by the script). Re-claimable until expiry so a failed run stays
    // re-runnable; re-minting overwrites the previous code.
    setupCode: os.sandbox.setupCode.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        let hostname: string;
        let payload: Record<string, string>;
        if (input.target.mode === `intentic`) {
            const { apiToken, zone } = context.config.intenticCloudflare;
            if (apiToken === `` || zone === ``) {
                throw new ORPCError(`NOT_FOUND`, { message: `intentic-provided sandboxes are not enabled` });
            }
            const connectToken = decryptSecret(context.config, sandbox.token);
            hostname = sandboxHostname(zone, connectToken);
            if (sandbox.tunnelToken === null) {
                // Surface WHY like hostTunnel below — a raw throw serializes as a bare "Internal server error".
                try {
                    const tunnel = await provisionSandboxTunnel({ apiToken, zone, connectToken });
                    await context.prisma.sandbox.update({
                        where: { id: sandbox.id },
                        data: { tunnelToken: encryptSecret(context.config, tunnel.tunnelToken), tunnelHostname: tunnel.hostname },
                    });
                } catch (error) {
                    if (error instanceof CloudflareTokenError) {
                        throw new ORPCError(`BAD_REQUEST`, { message: error.message });
                    }
                    if (error instanceof Error) {
                        throw new ORPCError(`BAD_GATEWAY`, { message: error.message });
                    }
                    throw error;
                }
            }
            // SANDBOX_HOSTNAME both feeds the connect script and marks the code as intentic-mode for /setup/claim.
            payload = { SANDBOX_HOSTNAME: hostname };
        } else {
            hostname = `${input.target.subdomain}.${input.target.zone}`;
            payload = { ZONE: input.target.zone, SUBDOMAIN: input.target.subdomain };
        }
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
        });
        return toSummary(sandbox, `owner`, context);
    }),
};
