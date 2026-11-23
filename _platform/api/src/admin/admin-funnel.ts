import type { AdminFunnel, AdminFunnelStages } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "../durations.js";
import { internalAccountMatcher } from "../me/internal-accounts.js";

// Every stage counts distinct accounts, so each is a superset of the next and conversion is a subtraction. `setupEngaged`
// unions the lanes' different stamps; narrower would undercount a lane.
//
// THE TEAM'S OWN ACCOUNTS ARE LEFT OUT (2026-11-23): operators, the hosted canary and the deployment's listed test
// accounts (internal-accounts.ts) made most of the early funnel, so every figure here is without them, and `unfiltered`
// keeps the stages with them in. And connected and active are split by where the sandbox runs, hosted or the owner's
// own machine, since the two journeys convert nothing alike. One read of every account and its sandboxes, counted here
// rather than in five relation filters: the matcher is a config list Postgres cannot see, and this is the operator
// panel at a scale of thousands of rows.
//
// No "came back on a later day" here: the platform keeps no visit history. A session's updatedAt moves at most once a
// day while any tab of it is open, a tab left open overnight moves it with nobody there, and an expired session is
// deleted (retention.ts), taking its evidence with it. The KPI snapshot reads returns from product analytics instead
// (marketing/bin/mkt.mjs).

const SERIES_DAYS = 30;

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

interface SandboxRow {
    readonly id: string;
    readonly tunnelId: string;
    readonly setupCodeClaimedAt: Date | null;
    readonly lastSeenAt: Date | null;
    readonly firstAnnouncedAt: Date | null;
    readonly hosted: { readonly id: string } | null;
}
interface AccountRow {
    readonly id: string;
    readonly email: string;
    readonly createdAt: Date;
    readonly sandboxes: readonly SandboxRow[];
    readonly hostedProvisions: readonly { readonly appName: string }[];
}

// Hosted while its machine row stands, or after: the provision record keeps the app name (`<prefix>-<tunnel id>`,
// hosted.ts) once an idle collection has dropped the machine, so a collected hosted sandbox never reads as own-machine.
const hostedOf = (account: AccountRow, sandbox: SandboxRow, appPrefix: string): boolean =>
    sandbox.hosted !== null ||
    account.hostedProvisions.some((provision) => provision.appName === `${appPrefix}-${sandbox.tunnelId}` || provision.appName === `${appPrefix}-${sandbox.id}`);

const stagesOf = (accounts: readonly AccountRow[], activeSince: Date): AdminFunnelStages => ({
    accounts: accounts.length,
    withSandbox: accounts.filter((account) => account.sandboxes.length > 0).length,
    setupEngaged: accounts.filter((account) =>
        account.sandboxes.some((sandbox) => sandbox.setupCodeClaimedAt !== null || sandbox.hosted !== null || sandbox.lastSeenAt !== null),
    ).length,
    connected: accounts.filter((account) => account.sandboxes.some((sandbox) => sandbox.lastSeenAt !== null)).length,
    activeLast7: accounts.filter((account) => account.sandboxes.some((sandbox) => sandbox.lastSeenAt !== null && sandbox.lastSeenAt >= activeSince)).length,
});

// Connected and active per lane. An account with a sandbox in each counts in both, so the two may add up past `connected`.
const laneOf = (accounts: readonly AccountRow[], activeSince: Date, appPrefix: string, hosted: boolean) => {
    const inLane = (account: AccountRow) => account.sandboxes.filter((sandbox) => hostedOf(account, sandbox, appPrefix) === hosted);
    return {
        connected: accounts.filter((account) => inLane(account).some((sandbox) => sandbox.lastSeenAt !== null)).length,
        activeLast7: accounts.filter((account) => inLane(account).some((sandbox) => sandbox.lastSeenAt !== null && sandbox.lastSeenAt >= activeSince)).length,
    };
};

export const adminFunnel = async (
    prisma: PrismaClient,
    // The lists the team's accounts are read from (internal-accounts.ts), and the prefix hosted apps are named with.
    config: { readonly admin: { readonly emails: string }; readonly hosted: { readonly canaryEmail: string; readonly appPrefix: string }; readonly telemetry: { readonly internalAccounts: string } },
    now: () => Date = () => new Date(),
): Promise<AdminFunnel> => {
    const at = now();
    const utcMidnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const seriesStart = new Date(utcMidnight.getTime() - (SERIES_DAYS - 1) * DAY_MS);
    const activeSince = new Date(at.getTime() - 7 * DAY_MS);
    const everyone: AccountRow[] = await prisma.user.findMany({
        select: {
            id: true,
            email: true,
            createdAt: true,
            sandboxes: { select: { id: true, tunnelId: true, setupCodeClaimedAt: true, lastSeenAt: true, firstAnnouncedAt: true, hosted: { select: { id: true } } } },
            hostedProvisions: { select: { appName: true } },
        },
    });
    const internal = internalAccountMatcher(config);
    const accounts = everyone.filter((account) => !internal(account.email));
    const signedUpSince = (since: Date) => accounts.filter((account) => account.createdAt >= since).length;
    // Exactly SERIES_DAYS entries, zero-filled, oldest first, so the chart never has to guess at gaps.
    const buckets = new Map<string, number>();
    for (let index = 0; index < SERIES_DAYS; index += 1) {
        buckets.set(utcDayOf(new Date(seriesStart.getTime() + index * DAY_MS)), 0);
    }
    for (const account of accounts) {
        const day = utcDayOf(account.createdAt);
        const count = buckets.get(day);
        if (count !== undefined) {
            buckets.set(day, count + 1);
        }
    }
    return {
        signups: {
            today: signedUpSince(utcMidnight),
            last7: signedUpSince(activeSince),
            last30: signedUpSince(new Date(at.getTime() - 30 * DAY_MS)),
            total: accounts.length,
        },
        signupSeries: [...buckets.entries()].map(([day, count]) => ({ day, count })),
        funnel: stagesOf(accounts, activeSince),
        lanes: {
            hosted: laneOf(accounts, activeSince, config.hosted.appPrefix, true),
            ownMachine: laneOf(accounts, activeSince, config.hosted.appPrefix, false),
        },
        internalAccounts: everyone.length - accounts.length,
        unfiltered: stagesOf(everyone, activeSince),
        activation: timeToActivate(accounts, at),
    };
};

// Sign-up to first announce, median hours, over accounts whose first activation (the earliest firstAnnouncedAt of any
// of their sandboxes) landed in the last 30 days. Null when nobody activated in the window.
const timeToActivate = (accounts: readonly AccountRow[], at: Date): { medianHours: number; count: number } | null => {
    const windowStart = new Date(at.getTime() - 30 * DAY_MS);
    const hours: number[] = [];
    for (const account of accounts) {
        const first = account.sandboxes
            .map((sandbox) => sandbox.firstAnnouncedAt)
            .filter((announced): announced is Date => announced !== null)
            .reduce<Date | undefined>((earliest, announced) => (earliest === undefined || announced < earliest ? announced : earliest), undefined);
        if (first !== undefined && first >= windowStart) {
            hours.push(Math.max(0, (first.getTime() - account.createdAt.getTime()) / (60 * 60 * 1000)));
        }
    }
    if (hours.length === 0) {
        return null;
    }
    const sorted = hours.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return { medianHours: Math.round(median * 10) / 10, count: hours.length };
};
