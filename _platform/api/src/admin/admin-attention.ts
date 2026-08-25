import type { AdminAttention, AdminAttentionItem, BootReport, SetupReport } from "@intentic-app/api-contract";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { LIVE_STATUSES } from "../pool/pool-admission.js";

/* THE RED-ROWS FEED — every row that is a person's setup, money, or listing waiting on a human, composed
 * into sentences HERE so the vocabulary lives in one place and the panel stays a renderer.
 *
 * Each category is capped (`TAKE`) and the feed says so (`truncated`), because a bounded list that reads as
 * complete is worse than no list. Ordering is severity first, then newest, so the top of the feed is always
 * the worst thing that happened most recently. */

const TAKE = 20;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// A pool claim is an instant; one still `claimed` after this long is a claim that crashed mid-handoff.
const CLAIM_LINGER_MS = 15 * MINUTE_MS;
// A build is minutes of image pull; hours of `building` is a machine the reconcile should have collected.
const BUILD_STALE_MS = 2 * 60 * MINUTE_MS;
// Statements sweep back to the pool at expiry; start saying so while a nudge can still land.
const STATEMENT_WARN_MS = 60 * DAY_MS;
// A suspension is news for a week, evidence forever.
const SUSPENSION_NEWS_MS = 7 * DAY_MS;

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const dateWord = (at: Date): string => at.toISOString().slice(0, 10);

export const adminAttention = async (prisma: PrismaClient, config: Config, now: () => Date = () => new Date()): Promise<AdminAttention> => {
    const at = now();
    const [stuckSetups, unreachable, refusals, stuckPayouts, expiringStatements, disabledAccounts, pastDue, lingeringClaims, staleBuilds, canaries, suspensions] =
        await Promise.all([
            // Claimed by a machine, never announced: the setup that started and died somewhere in between.
            prisma.sandbox.findMany({
                where: { setupCodeClaimedAt: { not: null }, lastSeenAt: null },
                orderBy: { setupCodeClaimedAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, setupCodeClaimedAt: true, setupReport: true, owner: { select: { email: true } } },
            }),
            // Announcing but unreachable from outside: up, and usable by nobody.
            prisma.sandbox.findMany({
                where: { lastSeenAt: { not: null }, bootReport: { path: [`reach`], equals: `unreachable` } },
                orderBy: { lastSeenAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, lastSeenAt: true, bootReport: true, owner: { select: { email: true } } },
            }),
            // A live disagreement about where a sandbox lives — invisible to its owner by construction.
            prisma.sandbox.findMany({
                where: { announceRefusal: { not: Prisma.DbNull } },
                orderBy: { updatedAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, updatedAt: true, announceRefusal: true, owner: { select: { email: true } } },
            }),
            // Reserved, attempted, failed: money sitting in the open, the exact row payouts keep for a human.
            prisma.creatorPayout.findMany({
                where: { status: `pending`, attempts: { gt: 0 } },
                orderBy: { createdAt: `desc` },
                take: TAKE,
                select: { amountCents: true, attempts: true, lastError: true, createdAt: true, user: { select: { email: true } } },
            }),
            // Unclaimed earnings whose window is closing — a nudge now still reaches the publisher.
            prisma.creatorStatement.findMany({
                where: { payoutId: null, expiredAt: null, expiresAt: { lte: new Date(at.getTime() + STATEMENT_WARN_MS) } },
                orderBy: { expiresAt: `asc` },
                take: TAKE,
                select: { publisher: true, amountCents: true, expiresAt: true },
            }),
            // Finished onboarding, still unpayable: the creator did their part and the money cannot move.
            prisma.payoutAccount.findMany({
                where: { detailsSubmitted: true, payoutsEnabled: false },
                orderBy: { updatedAt: `desc` },
                take: TAKE,
                select: { disabledReason: true, updatedAt: true, user: { select: { email: true } } },
            }),
            // Stripe is retrying their card; premium already paused. Churn about to happen.
            prisma.membership.findMany({
                where: { status: `past_due` },
                orderBy: { updatedAt: `desc` },
                take: TAKE,
                select: { currentPeriodEnd: true, updatedAt: true, user: { select: { email: true } } },
            }),
            prisma.hostedPoolMachine.findMany({
                where: { state: `claimed`, updatedAt: { lt: new Date(at.getTime() - CLAIM_LINGER_MS) } },
                orderBy: { updatedAt: `asc` },
                take: TAKE,
                select: { appName: true, region: true, updatedAt: true },
            }),
            prisma.hostedPoolMachine.findMany({
                where: { state: `building`, updatedAt: { lt: new Date(at.getTime() - BUILD_STALE_MS) } },
                orderBy: { updatedAt: `asc` },
                take: TAKE,
                select: { appName: true, region: true, updatedAt: true },
            }),
            // The watch's counter mid-climb: still live, already failing, suspension a few probes away.
            prisma.service.findMany({
                where: { canaryFails: { gt: 0 }, status: { in: [...LIVE_STATUSES] } },
                orderBy: { canaryFails: `desc` },
                take: TAKE,
                select: { slug: true, canaryFails: true, updatedAt: true },
            }),
            prisma.service.findMany({
                where: { status: `suspended`, updatedAt: { gte: new Date(at.getTime() - SUSPENSION_NEWS_MS) } },
                orderBy: { updatedAt: `desc` },
                take: TAKE,
                select: { slug: true, suspendedFor: true, updatedAt: true },
            }),
        ]);

    const items: AdminAttentionItem[] = [
        ...stuckSetups.map((sandbox): AdminAttentionItem => {
            const report = sandbox.setupReport as SetupReport | null;
            const failure = report?.failed?.[0];
            return {
                kind: `stuck-setup`,
                severity: failure ? `danger` : `warning`,
                title: `Setup stuck for ${sandbox.owner.email} (“${sandbox.name}”)`,
                detail: failure
                    ? `${failure.check}: ${failure.problem}`
                    : report
                      ? `Machine reported stage “${report.stage}”, then nothing announced.`
                      : `The connect command was claimed by a machine; no report and no announce since.`,
                at: sandbox.setupCodeClaimedAt?.toISOString(),
                email: sandbox.owner.email,
                sandboxId: sandbox.id,
            };
        }),
        ...unreachable.map((sandbox): AdminAttentionItem => {
            const report = sandbox.bootReport as BootReport | null;
            return {
                kind: `unreachable-sandbox`,
                severity: `danger`,
                title: `“${sandbox.name}” (${sandbox.owner.email}) is up but unreachable from outside`,
                detail: report?.detail ?? `The daemon's own probe of its public address failed.`,
                at: sandbox.lastSeenAt?.toISOString(),
                email: sandbox.owner.email,
                sandboxId: sandbox.id,
            };
        }),
        ...refusals.map((sandbox): AdminAttentionItem => {
            const refusal = sandbox.announceRefusal as { announced?: string; expected?: string } | null;
            return {
                kind: `announce-refusal`,
                severity: `danger`,
                title: `“${sandbox.name}” (${sandbox.owner.email}) announces the wrong address`,
                detail: refusal ? `Announced ${refusal.announced}, expected ${refusal.expected}.` : undefined,
                at: sandbox.updatedAt.toISOString(),
                email: sandbox.owner.email,
                sandboxId: sandbox.id,
            };
        }),
        ...stuckPayouts.map(
            (payout): AdminAttentionItem => ({
                kind: `payout-stuck`,
                severity: `danger`,
                title: `${dollars(payout.amountCents)} payout to ${payout.user.email} failing (${payout.attempts} ${payout.attempts === 1 ? `attempt` : `attempts`})`,
                detail: payout.lastError ?? undefined,
                at: payout.createdAt.toISOString(),
                email: payout.user.email,
            }),
        ),
        ...expiringStatements.map(
            (statement): AdminAttentionItem => ({
                kind: `statement-expiring`,
                severity: `warning`,
                title: `${dollars(statement.amountCents)} owed to unclaimed publisher “${statement.publisher}” sweeps back ${dateWord(statement.expiresAt)}`,
                at: statement.expiresAt.toISOString(),
            }),
        ),
        ...disabledAccounts.map(
            (account): AdminAttentionItem => ({
                kind: `payout-account-disabled`,
                severity: `warning`,
                title: `${account.user.email} finished payout onboarding but cannot be paid`,
                detail: account.disabledReason ?? undefined,
                at: account.updatedAt.toISOString(),
                email: account.user.email,
            }),
        ),
        ...pastDue.map(
            (membership): AdminAttentionItem => ({
                kind: `membership-past-due`,
                severity: `warning`,
                title: `${membership.user.email}'s membership is past due`,
                detail: `Stripe is retrying; premium is paused. Period ran to ${dateWord(membership.currentPeriodEnd)}.`,
                at: membership.updatedAt.toISOString(),
                email: membership.user.email,
            }),
        ),
        ...lingeringClaims.map(
            (machine): AdminAttentionItem => ({
                kind: `pool-claim-lingering`,
                severity: `danger`,
                title: `Warm-pool machine ${machine.appName} (${machine.region}) stuck in “claimed”`,
                detail: `A claim is an instant; this one crashed mid-handoff. The reconcile should collect it.`,
                at: machine.updatedAt.toISOString(),
            }),
        ),
        ...staleBuilds.map(
            (machine): AdminAttentionItem => ({
                kind: `pool-build-stale`,
                severity: `warning`,
                title: `Warm-pool machine ${machine.appName} (${machine.region}) building for hours`,
                detail: `An image pull is minutes. The reconcile should have rebuilt or collected this one.`,
                at: machine.updatedAt.toISOString(),
            }),
        ),
        ...canaries.map(
            (service): AdminAttentionItem => ({
                kind: `service-canary`,
                severity: `warning`,
                title: `Service “${service.slug}”: ${service.canaryFails} consecutive canary ${service.canaryFails === 1 ? `failure` : `failures`}`,
                detail: `Suspends at ${config.pool.canaryFailures}.`,
                at: service.updatedAt.toISOString(),
                serviceSlug: service.slug,
            }),
        ),
        ...suspensions.map(
            (service): AdminAttentionItem => ({
                kind: `service-suspended`,
                severity: `danger`,
                title: `Service “${service.slug}” was suspended this week`,
                detail: service.suspendedFor ?? undefined,
                at: service.updatedAt.toISOString(),
                serviceSlug: service.slug,
            }),
        ),
    ];

    items.sort((a, b) => {
        if (a.severity !== b.severity) {
            return a.severity === `danger` ? -1 : 1;
        }
        return (b.at ?? ``).localeCompare(a.at ?? ``);
    });

    const truncated = [
        stuckSetups,
        unreachable,
        refusals,
        stuckPayouts,
        expiringStatements,
        disabledAccounts,
        pastDue,
        lingeringClaims,
        staleBuilds,
        canaries,
        suspensions,
    ].some((list) => list.length === TAKE);

    return { items, truncated };
};
