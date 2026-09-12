import { randomBytes } from "node:crypto";
import { apiContract, AnnounceRefusalSchema, BootReportSchema, HostedStatusSchema, SetupReportSchema } from "@intentic/api-contract";
import { Prisma } from "@intentic/prisma";
import type { MemberRole } from "@intentic/sandbox-contract";
import { GrantedRoleSchema, localHostname } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { CloudflareTokenError, listZoneNames } from "./cloudflare.js";
import { getMachine, isFlyGone, stopMachine } from "./hosted/fly/fly.js";
import {
    destroyHosted,
    forgetHostedMachine,
    HostedAlreadyProvisioned,
    type HostedProvisionArgs,
    hostedEnabled,
    HostedSlotsExhausted,
    provisionHosted,
    refreshHosted,
    slotsMessage,
    wakeHosted,
} from "./hosted/hosted.js";
import { HostedBuildRefused, type HostedBuildRefusal, hostedBuildStatus, rebuildOnMovedBase, requestHostedBuild } from "./hosted/build/hosted-build.js";
import { HostedAtCapacity, hostedCapacity } from "./hosted/hosted-capacity.js";
import { kickHostedPool } from "./hosted/hosted-pool.js";
import { hostedPlanEnabled, hostedSlotsOf, onHostedPlan } from "./hosted/hosted-plan.js";
import { closeHostedStretch, hostedBudgetOf, openHostedStretch, settleHostedStretch } from "./hosted/hosted-usage.js";
import { hostedRegionFor } from "./hosted/region.js";
import { mintSandbox } from "./mint-sandbox.js";
import { sendSetupLinkEmail } from "./setup-email.js";
import { ENV_INGRESS_URL, ENV_SANDBOX_GRANT } from "@intentic/sandbox-contract/ingress-contract";
import { mintOwnerTicket, OWNER_TICKET_TTL_MS } from "@intentic/sandbox-contract/owner-ticket";
import { ensureReachability, ingressEnabled } from "./reachability.js";

const os = implement(apiContract).$context<OrpcContext>();

// Long enough to retry a failed install command; short enough that a leaked pasted command goes stale fast.
const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

// Wire status per build refusal; `capacity` isn't the asker's fault, so it maps like provisioning does.
const REFUSAL_CODES = {
    off: `NOT_FOUND`,
    "no-machine": `NOT_FOUND`,
    mismatch: `CONFLICT`,
    invalid: `BAD_REQUEST`,
    busy: `TOO_MANY_REQUESTS`,
    daily: `TOO_MANY_REQUESTS`,
    ceiling: `TOO_MANY_REQUESTS`,
    budget: `PAYMENT_REQUIRED`,
    capacity: `SERVICE_UNAVAILABLE`,
} as const satisfies Record<HostedBuildRefusal, string>;

// PAYMENT_REQUIRED is this platform's own code, not oRPC's; the status must be set explicitly or oRPC's unknown-code
// fallback reports 500 for an ordinary, expected refusal.
const paymentRequired = (message: string): ORPCError<`PAYMENT_REQUIRED`, undefined> => new ORPCError(`PAYMENT_REQUIRED`, { status: 402, message });

const buildRefusal = (code: HostedBuildRefusal, message: string): ORPCError<string, undefined> =>
    REFUSAL_CODES[code] === `PAYMENT_REQUIRED` ? paymentRequired(message) : new ORPCError(REFUSAL_CODES[code], { message });

// States the browser narrates, taken from the contract so the two can't drift; anything else is `unknown`.
const MACHINE_STATES = HostedStatusSchema.shape.machine.options;

// Ingress's wildcard zone when the fabric is configured; a zone default alone must not flag a sandbox.
const intenticZoneOf = (context: OrpcContext): string | undefined => (ingressEnabled(context.config) ? context.config.ingress.zone : undefined);

// Loopback-certified name, from the zone that holds its DNS — not the ingress's reachability zone (they diverged when
// reachability moved off Cloudflare; see cloudflare.ts ensureLocalDnsRecord). Null when there's no local candidate.
const loopbackHostname = (config: Config, encryptedToken: string): string | null => {
    const { apiToken, zone } = config.intenticCloudflare;
    if (apiToken === `` || zone === ``) {
        return null;
    }
    const id = sandboxIdFromToken(decryptSecret(config, encryptedToken));
    return id === undefined ? null : localHostname(id, zone);
};

// Reboots the machine, or replaces it when Fly says it's gone. The dead row is deleted before reprovisioning:
// `sandboxId` is unique on HostedMachine, so keeping it would fail the new machine's write and strand the owner.
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
 * The slot count here is the EARLY answer, not the binding one: it is a read with no lock behind it, so two
 * provisions racing the same slot both pass it. What binds is the count hosted.ts takes under the owner's lock
 * as it writes the row (withHostedSlot), which this saves the honest case a provider round-trip to reach.
 *
 * The hour ceiling applies to a NEW machine as much as to a wake: a machine boots the moment it is created, so
 * without it here, releasing a spent machine and provisioning another would be the way around the limit. */
const assertHostedAllowance = async (context: OrpcContext, userId: string): Promise<void> => {
    const [used, slots] = await Promise.all([
        context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: userId } } }),
        // Plan's slot count while live, otherwise the free lane's one (hosted-plan.ts).
        hostedSlotsOf(context.prisma, context.config, userId),
    ]);
    if (used >= slots) {
        throw new ORPCError(`BAD_REQUEST`, { message: slotsMessage(used) });
    }
    const budget = await hostedBudgetOf(context.prisma, context.config, userId);
    if (budget.metered && budget.remainingMinutes === 0) {
        throw paymentRequired(
            `your ${budget.allowanceMinutes / 60} free hours are used up for this month, the hosted plan lifts the limit, or run it on a machine of your own and it never applies`,
        );
    }
};

/* THE CONNECT TOKEN IS THE OWNER'S AND ONLY THE OWNER'S: decrypted onto their row, null on a member's. The
 * browser needs it for exactly one daemon-side act, the first-bind that seeds ownership, and that is the owner's
 * act by definition: a member reaches a daemon that is already bound, where the daemon's authorize never reads
 * the header. On the PLATFORM side the same token is a credential in its own right — it spends the owner's
 * trial allowance (/trial), asks the owner's wallet for signatures (/wallet), and speaks as the sandbox to
 * /sandbox/announce and its siblings — so handing it to every accepted member made a `viewer` invite worth the
 * owner's whole platform-side standing, past every role floor the daemon enforces. */
const connectTokenFor = (config: Config, encryptedToken: string, role: MemberRole): string | null =>
    role === `owner` ? decryptSecret(config, encryptedToken) : null;

// Shape a sandbox row for the browser. `role` is the caller's relationship, owner rows drive management, member
// rows are access-only. daemonUrl is what the browser needs to reach the daemon directly (plus, for the owner,
// the connect token above); daemonUrl + lastSeenAt come from the daemon's announce.
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
        // Hosted machine relation; optional so a caller that skipped the include reads as not-hosted, never crashes.
        hosted?: { region: string; warm: boolean } | null;
        token: string;
    },
    role: MemberRole,
    context: OrpcContext,
) => {
    const zone = intenticZoneOf(context);
    // Validated on write; this parse only shields rows written before the schema existed.
    const report = SetupReportSchema.safeParse(sandbox.setupReport);
    // Same shield: an older image that never wrote a boot report reads as having said nothing.
    const boot = BootReportSchema.safeParse(sandbox.bootReport);
    // Refusal record; written whole by the announce route.
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
        token: connectTokenFor(context.config, sandbox.token, role),
        role,
        providedAddress: sandbox.daemonUrl !== null && zone !== undefined && new URL(sandbox.daemonUrl).hostname.endsWith(`.${zone}`),
        // Derived from the loopback zone, never `daemonUrl`: they are two different zones now.
        localHostname: loopbackHostname(context.config, sandbox.token),
    };
};

export const sandboxRoutes = {
    // Every sandbox the caller owns or was granted access to, owned first; includes token + daemonUrl so the browser
    // can reach each daemon directly.
    list: os.sandbox.list.handler(async ({ context }) => {
        const user = requireUser(context);
        const [owned, memberships] = await Promise.all([
            context.prisma.sandbox.findMany({ where: { ownerId: user.id }, include: { hosted: true }, orderBy: { createdAt: `asc` } }),
            // Only accepted memberships surface a shared sandbox; queried through the membership row (not `some`)
            // because it carries the caller's role.
            context.prisma.sandboxMember.findMany({
                where: { email: user.email.toLowerCase(), acceptedAt: { not: null } },
                include: { sandbox: { include: { hosted: true } } },
                orderBy: { sandbox: { createdAt: `asc` } },
            }),
        ]);
        return {
            sandboxes: [
                ...owned.map((sandbox) => toSummary(sandbox, `owner`, context)),
                // Same fallback as toInviteRecord: an unrecognized stored role degrades to the safest tier.
                ...memberships.map((membership) => toSummary(membership.sandbox, GrantedRoleSchema.catch(`viewer`).parse(membership.role), context)),
            ],
        };
    }),
    // Mints a new sandbox; unlimited per owner. Nothing is provisioned yet — reachability is a signature the first
    // setup mint or hosted provision computes in-process.
    create: os.sandbox.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const { sandbox } = await mintSandbox(context.prisma, context.config, { name: input.name, ownerId: user.id });
        return toSummary(sandbox, `owner`, context);
    }),
    // Renames and/or sets the switcher logo (`null` clears it); the `!== undefined` guards keep the two fields
    // independent.
    update: os.sandbox.update.handler(async ({ context, input }) => {
        await requireOwnedSandbox(context, input.sandboxId);
        const sandbox = await context.prisma.sandbox.update({
            where: { id: input.sandboxId },
            data: { ...(input.name !== undefined && { name: input.name }), ...(input.image !== undefined && { image: input.image }) },
            include: { hosted: true },
        });
        return toSummary(sandbox, `owner`, context);
    }),
    // Deleting the row is the revocation: a grant signs the sandbox's id, so a missing row just fails the next tunnel
    // registration. The machine is destroyed after the row, so a slow provider can't keep a removed sandbox on screen.
    delete: os.sandbox.delete.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        // Read the hosted record BEFORE the row goes, the cascade takes it, and its appName is the teardown.
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: input.sandboxId } });
        if (hosted !== null) {
            /* The machine's open awake stretch is charged to its owner's month BEFORE the cascade takes the row
             * that holds it (hosted-usage.ts closeHostedStretch): the meter reads open stretches live off the
             * row, so a delete used to be the one act that made hours disappear, and provision → work → delete
             * → provision was a free lane with no ceiling at all. The machine is destroyed below, so now is
             * when it stops. */
            await closeHostedStretch(context.prisma, hosted, sandbox.ownerId);
        }
        await context.prisma.sandbox.delete({ where: { id: input.sandboxId } });
        // Best-effort, after the row: a failed teardown just leaves an app the reaper collects.
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
    // Drops the caller's own membership; sandbox, owner and daemon are untouched, idempotent.
    leave: os.sandbox.leave.handler(async ({ context, input }) => {
        const user = requireUser(context);
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: input.sandboxId, email: user.email.toLowerCase() } });
        return { ok: true };
    }),
    // Zones a pasted Cloudflare token can see, for the deploy engine's own apps — unrelated to sandbox reachability.
    // Token used once here, never persisted or logged.
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
    // Whether this platform hosts sandboxes at all, and how many more the caller may create; read before the editor or
    // wizard offers anything.
    hostedOffer: os.sandbox.hostedOffer.handler(async ({ context }) => {
        const user = requireUser(context);
        if (!hostedEnabled(context.config)) {
            return { enabled: false, remaining: 0 };
        }
        const [used, slots, budget, plan, capacity] = await Promise.all([
            context.prisma.hostedMachine.count({ where: { sandbox: { ownerId: user.id } } }),
            hostedSlotsOf(context.prisma, context.config, user.id),
            // Included so the card states the ceiling before it's spent; omitted entirely when unmetered.
            hostedBudgetOf(context.prisma, context.config, user.id),
            // Separate from unmetered: a ceiling-less platform is also unmetered, but its card must not claim an
            // unbought plan.
            hostedPlanEnabled(context.config) ? onHostedPlan(context.prisma, context.config, user.id) : Promise.resolve(false),
            // Fleet-wide capacity, not this account's allowance: a fresh account can still meet a full provider.
            // Region-aware, since stock the residency rule forbids this caller isn't stock to promise.
            hostedCapacity(context.prisma, context.config, hostedRegionFor(context.config.hosted, context.headers)),
        ]);
        return {
            enabled: true,
            remaining: Math.max(0, slots - used),
            // Absent unless true: a lane with room says nothing, so this can't age into a false scare.
            ...(capacity.full ? { full: true } : {}),
            ...(budget.metered
                ? { hours: { allowance: Math.round(budget.allowanceMinutes / 60), remaining: Math.floor(budget.remainingMinutes / 60) } }
                : {}),
            ...(plan ? { plan: true } : {}),
        };
    }),
    // Gives an existing sandbox a machine; idempotent (an existing machine is returned, never duplicated). A warm claim
    // changes the row's token, digest and id, so the summary is re-read after provisioning rather than reused.
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
            // The `existing` check above has no lock, so a concurrent provision can slip past it; answered with the
            // machine that now exists rather than a gateway error.
            // No machine to give (hosted-capacity.ts), never this caller's fault: SERVICE_UNAVAILABLE, not BAD_GATEWAY,
            // since only the first means come back or use another rung.
            if (error instanceof HostedAtCapacity) {
                throw new ORPCError(`SERVICE_UNAVAILABLE`, { message: error.message });
            }
            /* The allowance check above passed and the row-write's own count (hosted.ts withHostedSlot) did
             * not: a provision for ANOTHER of this owner's sandboxes committed in between. The machine this
             * call built is already torn down; the answer is the same sentence the early check would have said. */
            if (error instanceof HostedSlotsExhausted) {
                throw new ORPCError(`BAD_REQUEST`, { message: error.message });
            }
            if (!(error instanceof HostedAlreadyProvisioned)) {
                throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `creating the hosted machine failed` });
            }
            context.logger.info({ sandboxId: sandbox.id }, `hosted provision: a concurrent provision won; answering with its machine`);
        }
        // Restocks the pool now rather than waiting for the next tick; fire-and-forget, never this caller's wait.
        kickHostedPool(context.prisma, context.config, context.logger);
        const fresh = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
        return toSummary(fresh, `owner`, context);
    }),
    // Platform vouches for the owner (owner-ticket.ts); hosted-only, since only there does it already control the
    // machine and its env. Owner-only, short-lived, spent once on the daemon's session exchange.
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
    // Destroys the machine, keeps the sandbox; narrow on purpose — a sandbox that has ever connected has files on it,
    // and destroying that belongs to the delete dialog, not this card. Idempotent: no machine is a no-op.
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
            // A machine runs from the moment it is created (its row opens a stretch at provision), so even a
            // never-connected one has awake minutes to charge before its row goes; delete's reasoning verbatim.
            await closeHostedStretch(context.prisma, hosted, sandbox.ownerId);
            await context.prisma.hostedMachine.delete({ where: { sandboxId: sandbox.id } });
        }
        const fresh = await context.prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id }, include: { hosted: true } });
        return toSummary(fresh, `owner`, context);
    }),
    // What the machine itself is doing, the only signal that exists before the daemon does. A route, not a summary
    // field, since only the setup wait polls it; every failure degrades to `unknown` rather than throwing.
    hostedStatus: os.sandbox.hostedStatus.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id } });
        if (hosted === null || !hostedEnabled(context.config)) {
            return { machine: `unknown` as const };
        }
        const state = await getMachine(context.config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error: unknown) => {
            // Reported as `gone`, not `unknown`: the wait's two readings are opposites — keep waiting versus stop.
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
    // Reboots via stop, refresh, start; nothing destroyed (volume, files, address survive). When the provider has lost
    // the machine entirely, builds a replacement with the same identity instead of 404ing forever.
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
        // Settling now is exact, since the stop just ended the stretch; a restart is a start, so the budget applies
        // too.
        await settleHostedStretch(context.prisma, context.config, context.logger, hosted, sandbox.ownerId);
        const budget = await hostedBudgetOf(context.prisma, context.config, sandbox.ownerId);
        if (budget.metered && budget.remainingMinutes === 0) {
            throw paymentRequired(`your ${budget.allowanceMinutes / 60} free hours are used up this month; upgrade or self-host`);
        }
        try {
            const args = {
                sandboxId: sandbox.id,
                connectToken: decryptSecret(context.config, sandbox.token),
                ownerEmail: user.email.toLowerCase(),
                region: hosted.region,
            };
            const rebuilt = await restartOrRebuild(context, args, hosted);
            // A rebuild stamps `wokeAt` at creation; opening a stretch here too would meter one boot twice.
            if (!rebuilt) {
                await openHostedStretch(context.prisma, hosted.id);
                // Restart keeps the existing overlay; a moved base image triggers a background rebuild under the
                // owner's limits.
                await rebuildOnMovedBase(context.prisma, context.config, context.logger, hosted, { id: user.id, email: user.email.toLowerCase() });
            }
        } catch (error) {
            // The rebuild half provisions too, so it can meet a full fleet like any other provision; the sandbox and
            // its address survive regardless.
            if (error instanceof HostedAtCapacity) {
                throw new ORPCError(`SERVICE_UNAVAILABLE`, { message: error.message });
            }
            // The rebuild dropped this sandbox's row and found the owner's slots taken by then (a plan with fewer
            // slots than machines): the owner's own words, not a gateway's.
            if (error instanceof HostedSlotsExhausted) {
                throw new ORPCError(`BAD_REQUEST`, { message: error.message });
            }
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `restarting the machine failed` });
        }
        return { ok: true };
    }),
    // Builds the approved overlay into this sandbox's image (hosted-build.ts); owner-only from a session, never the
    // connect token. Content is re-hashed against the approved hash; every refusal is answered before anything is
    // spent.
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
                    // Platform-wide brake, at error level: a spent daily ceiling means a busy day, or somebody farming
                    // builds.
                    context.logger.error({ sandboxId: sandbox.id, ownerId: user.id }, `hosted build: the platform's daily build ceiling was reached`);
                }
                throw buildRefusal(error.code, error.message);
            }
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `starting the build failed` });
        }
    }),
    // Build the Environment card is watching, and what this machine last booted with.
    hostedBuildStatus: os.sandbox.hostedBuildStatus.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const hosted = await context.prisma.hostedMachine.findUnique({ where: { sandboxId: sandbox.id }, select: { id: true } });
        if (hosted === null) {
            return { build: null, applied: null };
        }
        return hostedBuildStatus(context.prisma, hosted.id);
    }),
    // Wakes a hosted machine for any authorized browser that finds the daemon unreachable; idempotent. Also the free
    // lane's only gate: hours bill to the owner, never the caller, on a shared sandbox too.
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
            // Addressed as "this sandbox's" hours, not "your": the reader may not be the account that spent them.
            throw paymentRequired(`this sandbox's ${budget.allowanceMinutes / 60} free hours are used up this month; upgrade or self-host`);
        }
        try {
            await wakeHosted(context.config, sandbox.hosted);
        } catch (error) {
            // Fly saying the machine is gone is terminal, not a bad minute: this wake reflex is the only moment
            // anything asks about it, so the row and the sandbox's address are dropped here rather than left to the
            // nightly sweep.
            if (isFlyGone(error)) {
                await forgetHostedMachine(context.prisma, sandbox.hosted.id, sandbox.id);
                context.logger.warn(
                    { app: sandbox.hosted.appName, sandboxId: sandbox.id },
                    `hosted wake: the provider has no such machine; the row and the sandbox's address are dropped`,
                );
                throw new ORPCError(`NOT_FOUND`, {
                    message: `the machine this sandbox ran on no longer exists; give it a new one from setup`,
                });
            }
            throw new ORPCError(`BAD_GATEWAY`, { message: error instanceof Error ? error.message : `waking the machine failed` });
        }
        // Only after a start that actually succeeded; a failed wake must not be billed.
        await openHostedStretch(context.prisma, sandbox.hosted.id);
        return { ok: true };
    }),
    // Whether this platform mints addresses, the same switch setupCode enforces; asked here so the wizard never draws a
    // lane it has to take back down.
    addressOffer: os.sandbox.addressOffer.handler(({ context }) => {
        requireUser(context);
        return { enabled: ingressEnabled(context.config) };
    }),
    // Mints the short-lived code the install command carries instead of raw tokens, with the reachability grant signed
    // and stashed in its payload. Re-claimable until expiry; re-minting is safe since the grant is the same claim
    // either way.
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
        // Seeds the daemon's owner binding with the creator's own email, so ownership always matches the intentic
        // account.
        payload[`OWNER_EMAIL`] = user.email.toLowerCase();
        const code = randomBytes(8).toString(`base64url`);
        const expiresAt = new Date(Date.now() + SETUP_CODE_TTL_MS);
        // Claim stamp belongs to the code: a fresh code must start unclaimed, or the wizard would report a stale claim.
        await context.prisma.sandbox.update({
            where: { id: sandbox.id },
            data: {
                setupCode: code,
                setupCodeExpiresAt: expiresAt,
                setupCodeClaimedAt: null,
                // Cleared here too: a fresh code means a fresh run, and last run's report would narrate the wrong one.
                setupReport: Prisma.DbNull,
                setupPayload: encryptSecret(context.config, JSON.stringify(payload)),
            },
        });
        return { code, hostname, expiresAt: expiresAt.toISOString() };
    }),
    // Mails a setup link to the session's own email, never an input — never usable to mail anyone else. Not plan-gated
    // or specially rate-limited: it's an escape hatch that costs nothing to ignore.
    emailSetupLink: os.sandbox.emailSetupLink.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await sendSetupLinkEmail(context.config, context.logger, { to: user.email, sandboxName: sandbox.name, sandboxId: sandbox.id });
        return { ok: true };
    }),
    // Owner-asserted counterpart to the daemon's announce, for a daemon that can't phone home. The browser already
    // probed and was authorized by the daemon first; the platform never dials into a sandbox, so that's the only
    // verification there is.
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
