import { FREE_TIER } from "@intentic/constants";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { mergeStanding, STANDING_RETENTION_MS, standingKeysOf } from "./sandbox/hosted/abuse/carried-standing.js";
import { destroyQueuedApps, lockHostedSandbox, queueHostedTeardown } from "./sandbox/hosted/hosted-cleanup.js";
import { eraseStripeCustomer, queueStripeErasure } from "./sandbox/hosted/plan/hosted-plan.js";
import type { StripeGateway } from "./sandbox/hosted/plan/hosted-plan-stripe.js";
import { accountHoursOf, usageMonth } from "./sandbox/hosted/hosted-usage.js";
import { lockOrganisation, rulesOf } from "./org/org-policy.js";

/* Before deleting the user row, atomically queue all owned hosted resources and Stripe erasure, move standing to the Google-subject hash,
 * delete sandbox/trash rows so in-flight provisions clean themselves up, and drop every row keyed by the address rather than the
 * account (memberships, invites, organisation seats). Owner and operator deletions share this path.
 * Attempt immediate cleanup best-effort; queued failures remain for sweeps. Upsert queues and moved standing make retries idempotent. */

export interface AccountErasure {
    // Every app queued for teardown, and those confirmed destroyed by the time the call returned.
    readonly apps: readonly string[];
    readonly destroyed: readonly string[];
    // The account's Stripe customer: none, deleted now, or queued for the daily sweep.
    readonly stripe: `none` | `erased` | `queued`;
    // Whether a hosted-standing record was written for the account's Google subject or address.
    readonly carried: boolean;
}

// Why an erase was refused before anything was touched: the transaction rolls back whole, and the message says what the
// person (or an operator) must do first. Both deletions answer it as a refusal rather than a fault.
export class ErasureRefused extends Error {}

// Refused before anything is touched: the account owns sandboxes an organisation holds (docs/architecture/organisations.md).
// The organisation's work in them is not the person's to erase with their account, and the erase would destroy them with
// no recovery window. An admin of the organisation releases them first (org.unbindSandbox), or hands the account's
// work over; then the account goes as any other does.
export class OwnsOrganisationSandboxes extends ErasureRefused {
    constructor(readonly sandboxes: readonly { readonly name: string; readonly org: string }[]) {
        const orgs = [...new Set(sandboxes.map((sandbox) => sandbox.org))].join(`, `);
        super(
            `this account owns ${sandboxes.map((sandbox) => sandbox.name).join(`, `)}, which ${orgs} holds; an admin of ${orgs} must release ${
                sandboxes.length === 1 ? `it` : `them`
            } before the account can be deleted`,
        );
        this.name = `OwnsOrganisationSandboxes`;
    }
}

// Refused too: the account is the only admin of an organisation other people are still in. With its seat gone nobody
// could administer it, change its policy or release a sandbox from it, the rule org.routes.ts `lastAdmin` holds an
// admin's own removal to.
class LastOrganisationAdmin extends ErasureRefused {
    constructor(readonly orgs: readonly string[]) {
        super(`this account is the only admin of ${orgs.join(`, `)}; make another member an admin before the account can be deleted`);
        this.name = `LastOrganisationAdmin`;
    }
}

// The account's sandboxes an organisation holds, or none. The erase reads it inside its transaction, after it has taken
// every owned sandbox's row lock: a bind takes the same lock (org.routes.ts), so one that committed first is seen here
// and refuses the erase, and one still waiting finds the sandbox gone.
export const organisationSandboxesOf = async (prisma: Pick<Prisma.TransactionClient, "sandbox">, userId: string): Promise<{ name: string; org: string }[]> =>
    (
        await prisma.sandbox.findMany({
            where: { ownerId: userId, orgId: { not: null } },
            select: { name: true, org: { select: { name: true } } },
            orderBy: { createdAt: `asc` },
        })
    ).map((sandbox) => ({ name: sandbox.name, org: sandbox.org?.name ?? `an organisation` }));

/* THE ACCOUNT'S PLACES KEYED BY ITS ADDRESS (2026-11-24): an organisation seat, a grant to somebody else's sandbox, an
 * invite still pending. Nothing cascades them from the user row, so an account made later on the same address inherited
 * every one. Each organisation the address sits in is locked before any sandbox, the order a bind takes them in
 * (org.routes.ts), and read under that lock. An organisation left with nobody in it goes too, since nobody could open it
 * again; one that keeps its sandboxes to its people (`membersOnly`) moves to a new policy edition, so each bound daemon's
 * roster drops the person at its next fetch, as an admin's removal does. */
const lockedSeatsOf = async (tx: Prisma.TransactionClient, email: string): Promise<string[]> => {
    const seats = await tx.orgMember.findMany({ where: { email }, select: { orgId: true }, orderBy: { orgId: `asc` } });
    for (const seat of seats) {
        // row locks, taken one after another in a fixed order
        await lockOrganisation(tx, seat.orgId);
    }
    return seats.map((seat) => seat.orgId);
};

const releaseAddress = async (tx: Prisma.TransactionClient, email: string, orgIds: readonly string[]): Promise<void> => {
    const emptied: string[] = [];
    const reissued: string[] = [];
    const stranded: string[] = [];
    for (const orgId of orgIds) {
        const members = await tx.orgMember.findMany({ where: { orgId }, select: { email: true, role: true } });
        const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { name: true, policy: true } });
        const others = members.filter((member) => member.email !== email);
        if (others.length === 0) {
            emptied.push(orgId);
        } else if (members.some((member) => member.email === email && member.role === `admin`) && !others.some((member) => member.role === `admin`)) {
            stranded.push(org?.name ?? `an organisation`);
        } else if (org !== null && rulesOf(org.policy).membersOnly === true) {
            reissued.push(orgId);
        }
    }
    // Before any write: nothing of the account has been touched yet, so the refusal leaves it whole.
    if (stranded.length > 0) {
        throw new LastOrganisationAdmin(stranded);
    }
    for (const orgId of reissued) {
        await tx.organisation.update({ where: { id: orgId }, data: { policyVersion: { increment: 1 } } });
    }
    await tx.orgMember.deleteMany({ where: { email } });
    await tx.organisation.deleteMany({ where: { id: { in: emptied } } });
    await tx.sandboxMember.deleteMany({ where: { email } });
};

// The latest of the moments a standing was last changed at, or null when there are none.
const latest = (moments: readonly (Date | null | undefined)[]): Date | null =>
    moments.reduce<Date | null>((best, at) => (at != null && (best === null || at > best) ? at : best), null);

/* Moves the account's hosted standing onto the records of its Google subject and its address. Returns whether a record
 * was written: one in good standing with no free minutes this month has nothing to carry. */
const carryStanding = async (tx: Prisma.TransactionClient, config: Config, userId: string, now: Date): Promise<boolean> => {
    const account = await tx.account.findFirst({ where: { userId, providerId: `google` }, select: { accountId: true } });
    const month = usageMonth(now);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { hostedSuspendedAt: true, email: true } });
    const keys = standingKeysOf(config, { subject: account?.accountId, email: user?.email });
    if (keys.length === 0) {
        return false;
    }
    // The watch's strikes that count towards a suspension, over the window the record itself is kept for.
    const strikes = await tx.hostedStrike.findMany({
        where: { userId, action: { in: [`stopped`, `suspended`] }, createdAt: { gte: new Date(now.getTime() - STANDING_RETENTION_MS) } },
        select: { createdAt: true },
    });
    const carried = mergeStanding(await Promise.all(keys.map((subjectHash) => tx.hostedStanding.findUnique({ where: { subjectHash } }))));
    // This month's free minutes as the meter counts them: settled, open stretches, and a record already carried.
    const hours = await accountHoursOf(tx, config, userId, now);
    const suspendedAt = user?.hostedSuspendedAt ?? carried?.suspendedAt ?? null;
    const strikeCount = strikes.length + (carried?.strikes ?? 0);
    const freeMinutes = hours.free.usedMinutes;
    const standingAt = suspendedAt === null && strikeCount === 0 ? null : latest([user?.hostedSuspendedAt, carried?.standingAt, ...strikes.map((row) => row.createdAt)]);
    if (standingAt === null && freeMinutes === 0) {
        return false;
    }
    const record = { suspendedAt, strikes: strikeCount, standingAt, month: freeMinutes === 0 ? null : month, freeMinutes };
    await Promise.all(keys.map((subjectHash) => tx.hostedStanding.upsert({ where: { subjectHash }, create: { subjectHash, ...record }, update: record })));
    // Moved, not copied: a second run of this erase must find nothing of the account's own left to add again.
    await tx.hostedStrike.deleteMany({ where: { userId } });
    await tx.hostedUsage.deleteMany({ where: { ownerId: userId, month, tier: FREE_TIER.id } });
    await tx.user.update({ where: { id: userId }, data: { hostedSuspendedAt: null, hostedSuspendedReason: null } });
    return true;
};

export const eraseAccount = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    userId: string,
    // Injectable so tests drive Stripe without it, as in the plan routes.
    opts: { readonly gateway?: StripeGateway; readonly now?: Date } = {},
): Promise<AccountErasure> => {
    const now = opts.now ?? new Date();
    const { apps, stripe, carried } = await prisma.$transaction(async (tx) => {
        // Memberships and invites are stored under the address as typed in lowercase (invite.routes.ts, org.routes.ts).
        const email = (await tx.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email.toLowerCase();
        const seats = email === undefined ? [] : await lockedSeatsOf(tx, email);
        // In id order, the one order every erase takes them in; each is the lock a provision's handoff and a release take.
        const sandboxes = await tx.sandbox.findMany({ where: { ownerId: userId }, select: { id: true }, orderBy: { id: `asc` } });
        for (const sandbox of sandboxes) {
            // row locks, taken one after another in a fixed order
            await lockHostedSandbox(tx, sandbox.id);
        }
        // Before anything is queued, carried or deleted: the transaction rolls back whole if an organisation holds one.
        const institutional = await organisationSandboxesOf(tx, userId);
        if (institutional.length > 0) {
            throw new OwnsOrganisationSandboxes(institutional);
        }
        if (email !== undefined) {
            await releaseAddress(tx, email, seats);
        }
        const machines = await tx.hostedMachine.findMany({ where: { sandbox: { ownerId: userId } }, select: { appName: true } });
        const trashed = await tx.sandboxTrash.findMany({ where: { ownerId: userId, appName: { not: null } }, select: { appName: true } });
        // A provision in flight and a released machine's held volume are named by nothing of the account's but its
        // provision rows; the ones with a teardown already queued are the ones still standing.
        const provisioned = await tx.hostedProvision.findMany({ where: { userId }, select: { appName: true } });
        const held = await tx.hostedCleanup.findMany({ where: { appName: { in: provisioned.map((row) => row.appName) } }, select: { appName: true } });
        const names = [...new Set([...machines, ...trashed, ...held].map((row) => row.appName).filter((name): name is string => name !== null))];
        await queueHostedTeardown(tx, names, now);
        const queued = await queueStripeErasure(tx, userId);
        const wrote = await carryStanding(tx, config, userId, now);
        await tx.sandboxTrash.deleteMany({ where: { ownerId: userId } });
        await tx.sandbox.deleteMany({ where: { ownerId: userId } });
        return { apps: names, stripe: queued, carried: wrote };
    });
    const destroyed = await destroyQueuedApps(prisma, config, logger, apps);
    const erased = stripe === undefined ? undefined : await eraseStripeCustomer(prisma, config, logger, stripe, opts.gateway);
    const outcome: AccountErasure = { apps, destroyed, stripe: erased === undefined ? `none` : erased ? `erased` : `queued`, carried };
    logger.info({ userId, ...outcome }, `account erase: hosted apps, Stripe customer and standing handled before the account goes`);
    return outcome;
};
