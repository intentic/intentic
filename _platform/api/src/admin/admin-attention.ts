import type { AdminAttention, AdminAttentionItem, BootReport, SetupReport } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "../durations.js";

// Every row that is a person's setup, plan, or machine waiting on a human, composed into sentences here. Each category
// is capped (`truncated` says so) and the event-shaped ones are windowed; ordered severity first, then newest.

const TAKE = 20;

const MINUTE_MS = 60 * 1000;

// A pool claim is an instant; one still `claimed` this long is a claim that crashed mid-handoff.
const CLAIM_LINGER_MS = 15 * MINUTE_MS;
// A build is minutes of image pull; hours of `building` is a machine the reconcile should have collected.
const BUILD_STALE_MS = 2 * 60 * MINUTE_MS;
// How far back the abuse watch's strikes stay on the feed; the account page keeps the rest.
const STRIKE_WINDOW_MS = 7 * DAY_MS;
// Setup, reach and announce rows record one moment that nothing ever clears, so they age off the feed like a strike does; must exceed the digest's day, or a row landing between two sends is announced by neither.
const EVENT_WINDOW_MS = 3 * DAY_MS;
const dateWord = (at: Date): string => at.toISOString().slice(0, 10);

// What the watch measured, in the operator's units.
const strikeWords = (strike: { kind: string; measure: number; windowMinutes: number }): string =>
    strike.kind === `cpu`
        ? `${Math.round(strike.measure * 100)}% CPU over ${strike.windowMinutes} min`
        : `${strike.measure.toFixed(1)} GB/h out over ${strike.windowMinutes} min`;

export const adminAttention = async (prisma: PrismaClient, now: () => Date = () => new Date()): Promise<AdminAttention> => {
    const at = now();
    const since = new Date(at.getTime() - EVENT_WINDOW_MS);
    const [stuckSetups, unreachable, refusals, pastDue, lingeringClaims, staleBuilds, strikes, suspended] = await Promise.all([
            // Claimed by a machine, never announced: the setup that started and died somewhere in between.
            prisma.sandbox.findMany({
                where: { setupCodeClaimedAt: { gt: since }, lastSeenAt: null },
                orderBy: { setupCodeClaimedAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, setupCodeClaimedAt: true, setupReport: true, owner: { select: { email: true } } },
            }),
            // Announcing but unreachable from outside: up, and usable by nobody.
            prisma.sandbox.findMany({
                where: { lastSeenAt: { gt: since }, bootReport: { path: [`reach`], equals: `unreachable` } },
                orderBy: { lastSeenAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, lastSeenAt: true, bootReport: true, owner: { select: { email: true } } },
            }),
            // A live disagreement about where a sandbox lives, invisible to its owner by construction.
            prisma.sandbox.findMany({
                where: { announceRefusal: { not: Prisma.DbNull }, updatedAt: { gt: since } },
                orderBy: { updatedAt: `desc` },
                take: TAKE,
                select: { id: true, name: true, updatedAt: true, announceRefusal: true, owner: { select: { email: true } } },
            }),
            // Stripe is retrying their card; the plan is already paused.
            prisma.hostedPlan.findMany({
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
            // The abuse watch's verdicts this week: a stop is worth a look, a suspension or a subscriber's report is
            // a person's call.
            prisma.hostedStrike.findMany({
                where: { createdAt: { gte: new Date(at.getTime() - STRIKE_WINDOW_MS) } },
                orderBy: { createdAt: `desc` },
                take: TAKE,
                select: { appName: true, kind: true, measure: true, windowMinutes: true, action: true, createdAt: true, user: { select: { email: true } } },
            }),
            // Accounts with the hosted lane off: each one waits on a human to lift it, or to decide not to.
            prisma.user.findMany({
                where: { hostedSuspendedAt: { not: null } },
                orderBy: { hostedSuspendedAt: `desc` },
                take: TAKE,
                select: { email: true, hostedSuspendedAt: true, hostedSuspendedReason: true },
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
        ...pastDue.map(
            (plan): AdminAttentionItem => ({
                kind: `plan-past-due`,
                severity: `warning`,
                title: `${plan.user.email}'s hosted plan is past due`,
                detail: `Stripe is retrying; the plan is paused and the free lane's ceiling applies. Period ran to ${dateWord(plan.currentPeriodEnd)}.`,
                at: plan.updatedAt.toISOString(),
                email: plan.user.email,
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
        ...strikes.map(
            (strike): AdminAttentionItem => ({
                kind: `hosted-strike`,
                severity: strike.action === `stopped` ? `warning` : `danger`,
                title:
                    strike.action === `reported`
                        ? `${strike.user.email}'s machine ${strike.appName} ran at full load on the plan`
                        : `${strike.user.email}'s machine ${strike.appName} was ${strike.action} for full load`,
                detail: `${strikeWords(strike)}, by the provider's own meter.${strike.action === `reported` ? ` A subscriber's machine is never stopped by the watch; this is for a person to judge.` : ``}`,
                at: strike.createdAt.toISOString(),
                email: strike.user.email,
            }),
        ),
        ...suspended.map(
            (user): AdminAttentionItem => ({
                kind: `hosted-suspended`,
                severity: `warning`,
                title: `${user.email}'s hosted lane is switched off`,
                detail: `${user.hostedSuspendedReason ?? `no reason recorded`}. Lift it from the account page, or leave it.`,
                at: user.hostedSuspendedAt?.toISOString(),
                email: user.email,
            }),
        ),
    ];

    items.sort((a, b) => {
        if (a.severity !== b.severity) {
            return a.severity === `danger` ? -1 : 1;
        }
        return (b.at ?? ``).localeCompare(a.at ?? ``);
    });

    const truncated = [stuckSetups, unreachable, refusals, pastDue, lingeringClaims, staleBuilds, strikes, suspended].some((list) => list.length === TAKE);

    return { items, truncated };
};
