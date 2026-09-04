import { randomBytes } from "node:crypto";
import { apiContract, AnnounceRefusalSchema, BootReportSchema, HostedStatusSchema, SetupReportSchema } from "@intentic-app/api-contract";
import { Prisma } from "@intentic-app/prisma";
import type { MemberRole } from "@intentic/sandbox-contract";
import { GrantedRoleSchema, localHostname } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { CloudflareTokenError, listZoneNames } from "./cloudflare.js";
import { getMachine, isFlyGone, stopMachine } from "./hosted/fly.js";
import {
    destroyHosted,
    HostedAlreadyProvisioned,
    type HostedProvisionArgs,
    hostedEnabled,
    provisionHosted,
    refreshHosted,
    wakeHosted,
} from "./hosted/hosted.js";
import { HostedBuildRefused, type HostedBuildRefusal, hostedBuildStatus, rebuildOnMovedBase, requestHostedBuild } from "./hosted/hosted-build.js";
import { kickHostedPool } from "./hosted/hosted-pool.js";
import { hostedBudgetOf, openHostedStretch, settleHostedStretch } from "./hosted/hosted-usage.js";
import { hostedRegionFor } from "./hosted/region.js";
import { mintSandbox } from "./mint-sandbox.js";
import { sendSetupLinkEmail } from "./setup-email.js";
import { ENV_INGRESS_URL, ENV_SANDBOX_GRANT } from "@intentic/sandbox-contract/ingress-contract";
import { mintOwnerTicket, OWNER_TICKET_TTL_MS } from "@intentic/sandbox-contract/owner-ticket";
import { ensureReachability, ingressEnabled } from "./reachability.js";

const os = implement(apiContract).$context<OrpcContext>();

// How long a minted setup code stays claimable. Long enough to install Docker mid-run and retry a failed
// command; short enough that a leaked pasted command goes stale quickly.
const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

// How each way a build can be refused (hosted-build.ts) is answered on the wire. Nothing here is a fault of
// the platform's: the two NOT_FOUNDs are a lane or a machine that does not exist, the rest are the brakes.
const REFUSAL_CODES = {
    off: `NOT_FOUND`,
    "no-machine": `NOT_FOUND`,
    mismatch: `CONFLICT`,
    invalid: `BAD_REQUEST`,
    busy: `TOO_MANY_REQUESTS`,
    daily: `TOO_MANY_REQUESTS`,
    ceiling: `TOO_MANY_REQUESTS`,
    budget: `PAYMENT_REQUIRED`,
} as const satisfies Record<HostedBuildRefusal, string>;

// The machine states the browser knows how to narrate, taken FROM the contract so the two can never drift.
// Anything Fly answers that isn't in here (a state they add, a shape we don't model) becomes `unknown`, which
// the wait renders as the plain spinner it has always had.
const MACHINE_STATES = HostedStatusSchema.shape.machine.options;

// The ingress's wildcard zone when the fabric is configured, else undefined, the zone alone defaults even when
// the fabric is off, so it must not flag sandboxes on its own.
const intenticZoneOf = (context: OrpcContext): string | undefined => (ingressEnabled(context.config) ? context.config.ingress.zone : undefined);

/* The loopback listener's certified name, from the zone that actually holds its DNS.
 *
 * Deliberately NOT `intenticZoneOf` above: that one answers "where is this sandbox REACHABLE", which is the
 * ingress's wildcard zone, and the loopback certificate lives in intentic's own DNS zone instead. They were the
 * same zone until reachability moved off Cloudflare, and every derivation that assumed so broke silently then.
 * Two questions, two zones, and this is the one the wildcard and the ACME challenge are written under
 * (cloudflare.ts ensureLocalDnsRecord).
 *
 * Null where there is nothing to name: no configured zone or token (the path is off), or a row whose connect
 * token yields no id. The browser reads null as "no local candidate at all" and rides the tunnel. */
const loopbackHostname = (config: Config, encryptedToken: string): string | null => {
    const { apiToken, zone } = config.intenticCloudflare;
    if (apiToken === `` || zone === ``) {
        return null;
    }
    const id = sandboxIdFromToken(decryptSecret(config, encryptedToken));
    return id === undefined ? null : localHostname(id, zone);
};

/* Reboot the machine this row describes, or, when Fly answers that there is no such machine, replace it.
 * Answers whether it had to rebuild, which is the caller's cue not to open a second metered stretch.
 *
 * The row is deleted BEFORE the new machine is provisioned, and deliberately: `provisionHosted` writes a
 * HostedMachine row of its own, `sandboxId` is unique on that table, and a provision that failed after the
 * delete leaves the sandbox with no machine, which is a state the wizard already knows how to offer a machine
 * for. Keeping the dead row instead would fail the write, lose the new machine to the reaper, and leave the
 * owner exactly as stuck as before. */
const restartOrRebuild = async (
    context: OrpcContext,
    args: HostedProvisionArgs,
    hosted: { id: string; appName: string; machineId: string; volumeId: string },
): Promise<boolean> => {
    try {
        await refreshHosted(context.config, args, hosted);
        return false;
    } catch (error) {
        if (!isFlyGone(error)) {
            throw error;
        }
        context.logger.warn(
            { app: hosted.appName, sandboxId: args.sandboxId },
            `hosted restart: the machine is gone from the provider; building a replacement for this sandbox`,
        );
        await context.prisma.hostedMachine.delete({ where: { id: hosted.id } });
        await provisionHosted(context.prisma, context.config, context.logger, args);
        return true;
    }
};

/* THE GATES A NEW HOSTED MACHINE PASSES, together because they are all refusals and none of them is about
 * provisioning: kept out of the handler so it reads as the three things it actually does (mint the grant, build
 * the machine, answer with the row).
 *
 * The hour ceiling applies to a NEW machine as much as to a wake: a machine boots the moment it is created, so
 * without it here, releasing a spent machine and provisioning another would be the way around the limit. */
const assertHostedAllowance = async (context: OrpcContext, userId: string): Promise<void> => {
    const used = await context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: userId } } });
    if (used >= context.config.hosted.perUser) {
        throw new ORPCError(`BAD_REQUEST`, {
            message: `you already have ${used === 1 ? `a hosted sandbox` : `${used} hosted sandboxes`}; remove one first`,
        });
    }
    const budget = await hostedBudgetOf(context.prisma, context.config, userId);
    if (budget.metered && budget.remainingMinutes === 0) {
        throw new ORPCError(`PAYMENT_REQUIRED`, {
            message: `your ${budget.allowanceMinutes / 60} free hours are used up for this month, a membership lifts the limit, or run it on a machine of your own and it never applies`,
        });
    }
};

// Shape a sandbox row for the browser. `role` is the caller's relationship, owner rows drive management, member
// rows are access-only. token + daemonUrl are what the browser needs to reach the daemon directly (the stored
// token is encrypted at rest, so it is decrypted here); daemonUrl + lastSeenAt come from the daemon's announce.
// `providedAddress` flags a daemonUrl under the platform's own zone, the browser reads it to tell a sandbox we
// made reachable (through the edge, by tunnel or by replay) from one the owner attached behind a domain of
// their own.
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
        bootReport: unknown;
        announceRefusal: unknown;
        // The hosted lane's machine record, every query feeding this summary includes the relation, so a
        // rename or an announce can never silently strip the hosted badge from the browser's row. Optional
        // (not just nullable) as the same shield the report parse below gives rows from before a schema
        // existed: a caller that skipped the include reads as "not hosted", never as a crash.
        hosted?: { region: string; warm: boolean } | null;
        token: string;
    },
    role: MemberRole,
    context: OrpcContext,
) => {
    const zone = intenticZoneOf(context);
    // The stored report was validated on write (/setup/report); the parse here only shields the summary from
    // rows written before this schema existed, anything unrecognizable reads as "no report".
    const report = SetupReportSchema.safeParse(sandbox.setupReport);
    // Same shield, same reason, for the daemon's own boot verdict (/sandbox/boot-report). A sandbox on an
    // image older than that route simply never writes one, which reads here as "said nothing", and the
    // wizard treats saying nothing exactly as it behaved before this existed.
    const boot = BootReportSchema.safeParse(sandbox.bootReport);
    // And for the refusal record, which the announce route writes whole.
    const refusal = AnnounceRefusalSchema.safeParse(sandbox.announceRefusal);
    return {
        id: sandbox.id,
        name: sandbox.name,
        image: sandbox.image,
        daemonUrl: sandbox.daemonUrl,
        lastSeenAt: sandbox.lastSeenAt === null ? null : sandbox.lastSeenAt.toISOString(),
        setupCodeClaimedAt: sandbox.setupCodeClaimedAt === null ? null : sandbox.setupCodeClaimedAt.toISOString(),
        setupReport: report.success ? report.data : null,
        bootReport: boot.success ? boot.data : null,
        announceRefusal: refusal.success ? refusal.data : null,
        hosted: sandbox.hosted === null || sandbox.hosted === undefined ? null : { region: sandbox.hosted.region, warm: sandbox.hosted.warm },
        token: decryptSecret(context.config, sandbox.token),
        role,
        providedAddress: sandbox.daemonUrl !== null && zone !== undefined && new URL(sandbox.daemonUrl).hostname.endsWith(`.${zone}`),
        /* Derived from the LOOPBACK zone, never from `daemonUrl`: those are two different zones now, and
         * conflating them is what took the certified shortcut down (see the schema). Null where the platform
         * runs no loopback-certificate path at all, which the browser reads as "no local candidate". */
        localHostname: loopbackHostname(context.config, sandbox.token),
    };
};

export const sandboxRoutes = {
    // Every sandbox the caller owns or has been granted access to (by email), owned first. The single read the
    // browser needs, token + daemonUrl included so it can reach each daemon directly.
    list: os.sandbox.list.handler(async ({ context }) => {
        const user = requireUser(context);
        const [owned, memberships] = await Promise.all([
            context.prisma.sandbox.findMany({ where: { ownerId: user.id }, include: { hosted: true }, orderBy: { createdAt: `asc` } }),
            // Only ACCEPTED memberships surface a shared sandbox, a pending invite must not reveal it before
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
    /* Mint a new sandbox for the caller. Unlimited, own as many as you like. Nothing is provisioned anywhere:
     * reachability is a signature the first setup mint (or hosted provision) computes in-process, which is why
     * the pre-provisioned pool the Cloudflare tunnels needed died with them and never came back. The row and
     * its token-derived columns come from mintSandbox, the same mint the hosted canary runs. */
    create: os.sandbox.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const { sandbox } = await mintSandbox(context.prisma, context.config, { name: input.name, ownerId: user.id });
        return toSummary(sandbox, `owner`, context);
    }),
    // Rename an owned sandbox and/or set its switcher logo (a small data URL the browser produced), `null`
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
    /* Remove an owned sandbox (cascades its member grants) and its hosted machine.
     *
     * DELETING THE ROW IS THE REVOCATION, which is why there is no teardown call before it any more. Under the
     * old tunnel hub, reachability was an account the platform had created upstream, so that account had to go
     * FIRST and the whole removal failed on a hub hiccup — the hub could not be asked what it held, so a grant
     * whose row was already gone could never be found again. The ingress inverts that: a grant is a signature
     * over this sandbox's id and nothing upstream holds a record of it, so the edge asks US on every tunnel
     * registration (GET /api/reachability/<id>) and a row that is not here answers 404 and refuses the tunnel.
     * One statement, nothing to strand, and nothing to reconcile tomorrow.
     *
     * The machine is still destroyed AFTER the row, for the reason it always was: the row is what the browser
     * reads, so a slow provider must not keep a just-removed sandbox on screen, and an app with no row is
     * exactly what the hosted reaper collects. The daemon keeps running on its host until cleanup.sh tears it
     * down there. */
    delete: os.sandbox.delete.handler(async ({ context, input }) => {
        await requireOwnedSandbox(context, input.sandboxId);
        // Read the hosted record BEFORE the row goes, the cascade takes it, and its appName is the teardown.
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: input.sandboxId } });
        await context.prisma.sandbox.delete({ where: { id: input.sandboxId } });
        // A hosted sandbox's machine dies with it, best-effort AFTER the row: the row is what the browser
        // reads, so a slow provider would otherwise keep a just-removed sandbox on screen, and a failed
        // teardown leaves an app with no row, which is exactly what the hosted reaper destroys tomorrow.
        if (hosted !== null) {
            try {
                await destroyHosted(context.config, hosted.appName);
            } catch (error) {
                context.logger.warn(
                    { err: error, sandboxId: input.sandboxId, app: hosted.appName },
                    `hosted machine teardown failed; orphaned for the reaper`,
                );
            }
        }
        return { ok: true };
    }),
    // Drop the caller's OWN member grant, a member removing a shared sandbox from their account. The sandbox,
    // its owner, and the daemon are untouched (the daemon's authorized list stays owner-pushed, like delete).
    // Idempotent; lowercased to match how share stores grants.
    leave: os.sandbox.leave.handler(async ({ context, input }) => {
        const user = requireUser(context);
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: input.sandboxId, email: user.email.toLowerCase() } });
        return { ok: true };
    }),
    // The zones a pasted Cloudflare token can see, the in-app Cloudflare capability's credential check (the
    // user's OWN zone, for the deploy engine's apps). Nothing to do with sandbox reachability, which the
    // self-hosted hub serves. Session-gated, used for this one call, then dropped, never persisted or logged.
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
    // The hosted lane's front door: whether this platform runs sandboxes at all, and how many more the caller
    // may create under the per-user allowance. The editor's zero-click first run and the wizard's lead card
    // both read this before offering anything.
    hostedOffer: os.sandbox.hostedOffer.handler(async ({ context }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            return { enabled: false, remaining: 0 };
        }
        const used = await context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: user.id } } });
        // The hour budget rides along so the lane's card can state the ceiling BEFORE anyone spends it, and
        // is omitted entirely for the unmetered (members, ceiling-less platforms), a limit that does not
        // apply to you should not appear on your screen at all.
        const budget = await hostedBudgetOf(context.prisma, context.config, user.id);
        return {
            enabled: true,
            remaining: Math.max(0, context.config.hosted.perUser - used),
            ...(budget.metered
                ? { hours: { allowance: Math.round(budget.allowanceMinutes / 60), remaining: Math.floor(budget.remainingMinutes / 60) } }
                : {}),
        };
    }),
    /* Give an existing sandbox a machine on intentic's own provider, the lane with no command, no code, no
     * paste, and the one a browser arrival now takes without being asked. The ROW is created the ordinary way
     * on arrival, and taking this lane moves a MACHINE, never the sandbox, so stepping off it onto the
     * reader's own computer keeps the name and address they already have.
     *
     * The machine's env carries the connect token and the public URL, then the daemon's ordinary announce
     * narrates the rest to the waiting browser, exactly as a pasted run's does. No grant and no tunnel: a
     * hosted machine is reached by the edge replaying to its app (hosted.ts). A warm claim hands the sandbox
     * the MACHINE's identity — the row's token, digest and id change under it — which is why the browser is
     * answered with the row re-read after provisioning rather than the one it arrived with. OWNER_EMAIL seeds
     * the daemon's first-bind exactly like setupCode's payload: only this Google identity may bind.
     *
     * Idempotent, a sandbox that already has a machine answers with itself rather than growing a second one,
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
        await assertHostedAllowance(context, user.id);
        if (!ingressEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `this platform has no reachability fabric configured` });
        }
        try {
            await provisionHosted(context.prisma, context.config, context.logger, {
                sandboxId: sandbox.id,
                connectToken: decryptSecret(context.config, sandbox.token),
                ownerEmail: user.email.toLowerCase(),
                region: hostedRegionFor(context.config.hosted, context.headers),
            });
        } catch (error) {
            /* A second provision for this sandbox committed while this one ran: the `existing` check above is a
             * read with no lock behind it, so a second tab, a retried request or the desktop app beside the
             * browser can both pass it. The machine exists, which is exactly what was asked for, so this
             * answers with it rather than with a gateway error the reader can do nothing about. */
            if (!(error instanceof HostedAlreadyProvisioned)) {
                throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `creating the hosted machine failed` });
            }
            context.logger.info({ sandboxId: sandbox.id }, `hosted provision: a concurrent provision won; answering with its machine`);
        }
        // The provision just spent (or found empty) a pool slot, start rebuilding stock now rather than
        // letting the replacement wait out the five-minute tick. Fire-and-forget: never this caller's wait.
        kickHostedPool(context.prisma, context.config, context.logger);
        const fresh = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
        return toSummary(fresh, `owner`, context);
    }),
    /* THE PLATFORM VOUCHING FOR THE OWNER OF A HOSTED SANDBOX (sandbox-contract's owner-ticket.ts, which carries
     * the trust argument in full). Hosted only, because only there does the platform already hold everything
     * the ticket could reach: it created the machine, keeps its power and disk, and wrote OWNER_EMAIL into its
     * env. Owner only: a member's way in stays the Google proof the daemon's roster is checked against. Signed
     * with the reachability key, verified offline by the daemon against the public half its env carries, and
     * good for minutes: spent once, on the daemon's session exchange. */
    ownerTicket: os.sandbox.ownerTicket.handler(async ({ context, input }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `hosted sandboxes are not enabled on this platform` });
        }
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id }, select: { id: true } });
        if (hosted === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sandbox does not run on a machine the platform hosts` });
        }
        const sandboxId = sandboxIdFromToken(decryptSecret(context.config, sandbox.token)) ?? ``;
        const issuedAtMs = Date.now();
        return {
            ticket: mintOwnerTicket(context.config.ingress.signingKey, { sandboxId, email: user.email.toLowerCase(), issuedAtMs }),
            expiresAt: new Date(issuedAtMs + OWNER_TICKET_TTL_MS).toISOString(),
        };
    }),
    /* The way back out of the hosted lane: destroy the machine, keep the sandbox. This is the wizard's
     * lane-switch (someone tries "we host it", then decides to run it on their own machine after all), which
     * is why it is deliberately narrow, a sandbox that has EVER connected is a workspace with a person's
     * files on it, and destroying its machine belongs to the delete dialog and the confirmation it shows,
     * never to a card being clicked. Idempotent: no machine is a no-op, not an error. */
    hostedRelease: os.sandbox.hostedRelease.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (hosted !== null) {
            if (sandbox.lastSeenAt !== null) {
                throw new ORPCError(`BAD_REQUEST`, {
                    message: `already started; remove it first to destroy the machine`,
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
    /* WHAT THE MACHINE ITSELF IS DOING, the only link of the setup chain that exists before the daemon does,
     * and therefore the only way to tell a machine that never booted from one that booted and went silent.
     * The setup wait polls this while it waits; nothing else does, which is the whole reason it is a route
     * rather than a field on the summary (a per-row provider call in `list` would be paid by every browser on
     * every poll, for a fact only one screen ever reads).
     *
     * Every failure answers `unknown` rather than throwing: this is narration for a screen that is ALREADY
     * waiting, and a provider hiccup must degrade it to the honest spinner it replaced, never break it or
     * turn a slow boot into an error. An unmodelled state does the same, which is what the enum's `unknown`
     * is for. Fly's vocabulary is theirs to extend. */
    hostedStatus: os.sandbox.hostedStatus.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (hosted === null || !hostedEnabled(context.config)) {
            return { machine: `unknown` as const };
        }
        const state = await getMachine(context.config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error: unknown) => {
            /* Fly ANSWERING that the machine (or its whole app) is not there is a fact, not a hiccup, and the
             * one fact this route exists to carry: nothing about that machine will ever change again. Reported
             * as `gone` rather than folded into `unknown`, because the wait's two readings are opposite, keep
             * waiting versus stop waiting, and flattening them is what left people watching a spinner for a
             * box that had been destroyed under them. */
            if (isFlyGone(error)) {
                return `gone` as const;
            }
            context.logger.warn({ err: error, app: hosted.appName }, `hosted status: reading the machine failed`);
            return undefined;
        });
        if (state === `gone`) {
            return { machine: `gone` as const };
        }
        const known = MACHINE_STATES.find((candidate) => candidate === state?.state);
        return { machine: known ?? (`unknown` as const) };
    }),
    /* Boot a hosted machine again, the setup wait's one recovery, for a daemon that never came up, a tunnel
     * that never bound, or a machine pinned to a broken image. Stop, refresh its full config from the current
     * hosted image while preserving its volume, then start; a stop that refuses because the machine is already
     * down is exactly the state we wanted, so only the refresh/start is allowed to fail the call.
     *
     * Owner-only, and nothing is destroyed, the volume, the files and the address all survive, which is what
     * separates this from hostedRelease and what makes it safe to put under a failure message somebody is
     * reading in frustration.
     *
     * AND WHEN THERE IS NO MACHINE LEFT TO BOOT, it builds one. A row whose Fly app has been destroyed under it
     * (a provider-side loss, or the orphan sweep of another deployment sharing the org, which is how this was
     * found) used to make this route 404 forever: the button under "the machine we started for you isn't
     * running" could not, in principle, ever work, and the row went on holding the owner's one hosted slot so
     * nothing else could be provisioned either. There is nothing to preserve on a machine that does not exist,
     * so the honest recovery is a new one on the same sandbox: same name, same address, same sharing, empty
     * disk. That is the same trade the idle sweep already makes when it collects a machine and keeps the
     * sandbox, and it is the only reading under which "start it over" is a true sentence. */
    hostedRestart: os.sandbox.hostedRestart.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (hosted === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sandbox has no machine we run` });
        }
        const user = requireUser(context);
        await stopMachine(context.config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error: unknown) =>
            context.logger.warn({ err: error, app: hosted.appName }, `hosted restart: stop refused; starting anyway`),
        );
        // The stop above just ended any open stretch, so settling now is exact rather than lazy. The budget
        // gate applies here too, a restart is a start, and a lane that refused to wake but agreed to restart
        // would be a limit with a button next to it.
        await settleHostedStretch(context.prisma, context.config, context.logger, hosted, sandbox.ownerId);
        const budget = await hostedBudgetOf(context.prisma, context.config, sandbox.ownerId);
        if (budget.metered && budget.remainingMinutes === 0) {
            throw new ORPCError(`PAYMENT_REQUIRED`, {
                message: `your ${budget.allowanceMinutes / 60} free hours are used up this month; upgrade or self-host`,
            });
        }
        try {
            const args = {
                sandboxId: sandbox.id,
                connectToken: decryptSecret(context.config, sandbox.token),
                ownerEmail: user.email.toLowerCase(),
                region: hosted.region,
            };
            const rebuilt = await restartOrRebuild(context, args, hosted);
            // A rebuild's row is stamped `wokeAt` as it is created (the machine runs from the moment it
            // exists), so opening a stretch again here would start the meter twice for one boot.
            if (!rebuilt) {
                await openHostedStretch(context.prisma, hosted.id);
                // The restart kept the overlay the machine had; if the platform's base image has moved past
                // the one it was built on, the same recipe goes through a build on the new base, in the
                // background and under the owner's limits, never as part of this call's answer.
                await rebuildOnMovedBase(context.prisma, context.config, context.logger, hosted, { id: user.id, email: user.email.toLowerCase() });
            }
        } catch (error) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `restarting the machine failed` });
        }
        return { ok: true };
    }),
    /* BUILD THE APPROVED OVERLAY INTO THIS SANDBOX'S IMAGE, the hosted lane's `ic sandbox rebuild`
     * (hosted-build.ts carries the design and every brake). Owner only, from a session, never the connect
     * token: an agent can draft and wait for the owner, and that is all. The content arrives with the hash the
     * owner approved and is re-hashed there; every refusal is answered before anything is spent, in the code
     * the card can act on: a limit is TOO_MANY_REQUESTS, spent hours PAYMENT_REQUIRED (the same word the wake
     * gate uses, so the editor offers the membership the same way), a changed overlay CONFLICT (re-read and
     * approve again, exactly as `ic` says on a docker host). */
    hostedRebuild: os.sandbox.hostedRebuild.handler(async ({ context, input }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `hosted sandboxes are not enabled on this platform` });
        }
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        try {
            return await requestHostedBuild(context.prisma, context.config, context.logger, {
                sandboxId: sandbox.id,
                ownerId: user.id,
                ownerEmail: user.email.toLowerCase(),
                hash: input.hash,
                content: input.content,
                requestedBy: user.email.toLowerCase(),
            });
        } catch (error) {
            if (error instanceof HostedBuildRefused) {
                if (error.code === `ceiling`) {
                    // The platform-wide brake, said at error level: a day whose builds are spent is either a
                    // busy day or somebody farming, and an operator wants to know which.
                    context.logger.error({ sandboxId: sandbox.id, ownerId: user.id }, `hosted build: the platform's daily build ceiling was reached`);
                }
                throw new ORPCError(REFUSAL_CODES[error.code], { message: error.message });
            }
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `starting the build failed` });
        }
    }),
    // The build the Environment card is watching, and what the platform last booted this machine with.
    hostedBuildStatus: os.sandbox.hostedBuildStatus.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id }, select: { id: true } });
        if (hosted === null) {
            return { build: null, applied: null };
        }
        return hostedBuildStatus(context.prisma, hosted.id);
    }),
    /* Power a hosted sandbox's machine back on, the idle-stop's other half, called by any browser (owner or
     * accepted member) that finds the daemon unreachable. Idempotent: waking a running machine is a no-op, so
     * the browser needs no machine-state oracle, it just wakes and keeps probing the daemon like always.
     *
     * ALSO THE FREE LANE'S ONLY GATE. The previous stretch is settled first (this is the moment Fly can tell
     * us when the machine actually stopped), then the owner's remaining hours decide whether this wake
     * happens at all. Everything is billed to the OWNER, never to the caller, a guest on a shared sandbox
     * spends the owner's month, which is the only reading under which sharing cannot launder machine time. */
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
        await settleHostedStretch(context.prisma, context.config, context.logger, sandbox.hosted, sandbox.ownerId);
        const budget = await hostedBudgetOf(context.prisma, context.config, sandbox.ownerId);
        if (budget.metered && budget.remainingMinutes === 0) {
            // Addressed to the person reading it, which on a shared sandbox may not be the account that spent
            // the hours, hence "this sandbox's" rather than "your". PAYMENT_REQUIRED so the editor can offer
            // the membership without string-matching a message.
            throw new ORPCError(`PAYMENT_REQUIRED`, {
                message: `this sandbox's ${budget.allowanceMinutes / 60} free hours are used up this month; upgrade or self-host`,
            });
        }
        try {
            await wakeHosted(context.config, sandbox.hosted);
        } catch (error) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `waking the machine failed` });
        }
        // Only after a start that actually succeeded: a wake that failed cost nothing and must not be billed.
        await openHostedStretch(context.prisma, sandbox.hosted.id);
        return { ok: true };
    }),
    /* Whether this platform mints addresses, the same switch `setupCode` enforces, asked without spending a
     * code. It exists because "the mint 404s" is a terrible way for a wizard to learn what it can offer: the
     * page had already drawn the lanes that need an address by the time the answer came back, and had to take
     * them off screen again. Cheap and session-only, like hostedOffer, and it reports the platform's
     * configuration rather than anything about the caller. */
    addressOffer: os.sandbox.addressOffer.handler(({ context }) => {
        requireUser(context);
        return { enabled: ingressEnabled(context.config) };
    }),
    /* Mint the short-lived setup code the install one-liner carries instead of raw tokens. One lane now: the
     * sandbox's reachability grant is signed here and stashed in the payload, so the pasted command carries a
     * code and nothing else, and the address it will answer on is a derivation of the connect token, known
     * before anything runs. Re-claimable until expiry so a failed run stays re-runnable; re-minting overwrites
     * the previous code and re-signs the grant, which is the same claim either way (there is no identity to
     * lose by minting a second one — see reachability.ts). */
    setupCode: os.sandbox.setupCode.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        if (!ingressEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `this platform has no reachability fabric configured` });
        }
        const grant = ensureReachability(context.config, sandbox);
        const hostname = grant.hostname;
        const payload: Record<string, string> = {
            [ENV_SANDBOX_GRANT]: grant.grant,
            [ENV_INGRESS_URL]: grant.ingressUrl,
            SANDBOX_HOSTNAME: hostname,
        };
        // Seed the creator's account email so the daemon binds ONLY this Google identity as owner (TOFU by
        // the intended person, not just whoever holds the connect token), daemon ownership then always
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
                // A fresh code describes a fresh run, last run's setup report would narrate the wrong one.
                setupReport: Prisma.DbNull,
                setupPayload: encryptSecret(context.config, JSON.stringify(payload)),
            },
        });
        return { code, hostname, expiresAt: expiresAt.toISOString() };
    }),
    /* Mail the owner a link back to this sandbox's setup screen. Owner-only and self-addressed: the recipient is
     * the SESSION's email, never an input, so this can only ever put a link in the requester's own inbox and is
     * no use to anyone as a way to send mail to someone else. What it carries is in setup-email.ts, and the short
     * version is that it carries nothing, the code, the command and the connect token all stay off it.
     *
     * Deliberately NOT plan-gated and NOT rate-limited beyond that: it is the escape hatch on the step where the
     * funnel loses people, its reach is one mail to the sender's own address, and the mail costs nothing
     * to ignore. */
    emailSetupLink: os.sandbox.emailSetupLink.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await sendSetupLinkEmail(context.config, context.logger, { to: user.email, sandboxName: sandbox.name, sandboxId: sandbox.id });
        return { ok: true };
    }),
    // Record where a sandbox the user ALREADY runs is reachable, the owner-asserted counterpart to the daemon's
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
