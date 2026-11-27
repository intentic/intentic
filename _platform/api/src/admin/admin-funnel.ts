import type { AdminFunnel, AdminFunnelStages } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "../durations.js";
import { internalAccountMatcher } from "../me/internal-accounts.js";

// Every stage counts distinct accounts, so each is a superset of the next and conversion is a subtraction. `setupEngaged`
// unions the lanes' different stamps; narrower would undercount a lane.
//
// ACTIVATION IS A PERSON'S FIRST FINISHED TURN (2026-11-26), not a container that came up: a daemon announces whether or
// not anyone ever got anything done in it. `firstTurn` counts accounts with a connected sandbox whose daemon recorded a
// turn a person started finishing without failing (Sandbox.firstTurnAt, sent on the announce; which turns count is the
// daemon's system/boot/first-turn.ts). Each later stage asks more of the same sandbox, so the chain nests by
// construction, and `activeLast7` is now a sandbox past its first turn that announced in the last seven days. It was any
// sandbox that announced in the week: a container's heartbeat, not use, and no subset of `firstTurn`. Daemons record the
// moment from that release on, so an account whose only use predates it reads as not activated until its next finished
// turn.
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
    readonly firstTurnAt: Date | null;
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

// The three sandbox-level stages, each the one before it and more of the same sandbox, so every count over them nests.
const connected = (sandbox: SandboxRow): boolean => sandbox.lastSeenAt !== null;
const pastFirstTurn = (sandbox: SandboxRow): boolean => connected(sandbox) && sandbox.firstTurnAt !== null;
const activeSinceOf =
    (activeSince: Date) =>
    (sandbox: SandboxRow): boolean =>
        pastFirstTurn(sandbox) && sandbox.lastSeenAt !== null && sandbox.lastSeenAt >= activeSince;

// How many of `accounts` have a sandbox among `sandboxesOf` that passes `stage`.
const countWith = (accounts: readonly AccountRow[], sandboxesOf: (account: AccountRow) => readonly SandboxRow[], stage: (sandbox: SandboxRow) => boolean): number =>
    accounts.filter((account) => sandboxesOf(account).some(stage)).length;

const everySandbox = (account: AccountRow): readonly SandboxRow[] => account.sandboxes;

const stagesOf = (accounts: readonly AccountRow[], activeSince: Date): AdminFunnelStages => ({
    accounts: accounts.length,
    withSandbox: accounts.filter((account) => account.sandboxes.length > 0).length,
    setupEngaged: countWith(accounts, everySandbox, (sandbox) => sandbox.setupCodeClaimedAt !== null || sandbox.hosted !== null || connected(sandbox)),
    connected: countWith(accounts, everySandbox, connected),
    firstTurn: countWith(accounts, everySandbox, pastFirstTurn),
    activeLast7: countWith(accounts, everySandbox, activeSinceOf(activeSince)),
});

// Connected, first turn and active per lane. An account with a sandbox in each counts in both, so the two may add up past
// the stage's own figure.
const laneOf = (accounts: readonly AccountRow[], activeSince: Date, appPrefix: string, hosted: boolean) => {
    const inLane = (account: AccountRow) => account.sandboxes.filter((sandbox) => hostedOf(account, sandbox, appPrefix) === hosted);
    return {
        connected: countWith(accounts, inLane, connected),
        firstTurn: countWith(accounts, inLane, pastFirstTurn),
        activeLast7: countWith(accounts, inLane, activeSinceOf(activeSince)),
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
            sandboxes: {
                select: { id: true, tunnelId: true, setupCodeClaimedAt: true, lastSeenAt: true, firstAnnouncedAt: true, firstTurnAt: true, hosted: { select: { id: true } } },
            },
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
        toFirstTurn: timeToFirstTurn(accounts, at),
    };
};

type Median = NonNullable<AdminFunnel["activation"]>;

// The earliest of a moment over an account's sandboxes; undefined when none has it.
const earliestOf = (account: AccountRow, moment: (sandbox: SandboxRow) => Date | null): Date | undefined =>
    account.sandboxes
        .map(moment)
        .filter((at): at is Date => at !== null)
        .reduce<Date | undefined>((earliest, at) => (earliest === undefined || at < earliest ? at : earliest), undefined);

const hoursSince = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / (60 * 60 * 1000));

// The median of `hours`, to a tenth, with how many it is over; null for none.
const medianOf = (hours: readonly number[]): Median | null => {
    if (hours.length === 0) {
        return null;
    }
    const sorted = hours.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return { medianHours: Math.round(median * 10) / 10, count: hours.length };
};

// Time to connect: sign-up to first announce, median hours, over accounts whose first activation (the earliest
// firstAnnouncedAt of any of their sandboxes) landed in the last 30 days. Null when nobody activated in the window.
const timeToActivate = (accounts: readonly AccountRow[], at: Date): Median | null => {
    const windowStart = new Date(at.getTime() - 30 * DAY_MS);
    return medianOf(
        accounts.flatMap((account) => {
            const first = earliestOf(account, (sandbox) => sandbox.firstAnnouncedAt);
            return first !== undefined && first >= windowStart ? [hoursSince(account.createdAt, first)] : [];
        }),
    );
};

// Time to first turn: sign-up to the earliest firstTurnAt of any of the account's sandboxes, median hours, over accounts
// that SIGNED UP in the last 30 days and have one. Windowed on sign-up, unlike the time to connect, because daemons only
// record the moment from 2026-11-26's release on: a sandbox that was used before it took that release reports its first
// turn since, and windowing on the turn would read every long-standing account's next turn as a first one that took
// months. Null when nobody in the window has had one.
const timeToFirstTurn = (accounts: readonly AccountRow[], at: Date): Median | null => {
    const windowStart = new Date(at.getTime() - 30 * DAY_MS);
    return medianOf(
        accounts.flatMap((account) => {
            const first = earliestOf(account, (sandbox) => sandbox.firstTurnAt);
            return first !== undefined && account.createdAt >= windowStart ? [hoursSince(account.createdAt, first)] : [];
        }),
    );
};
