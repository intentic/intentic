import { createHmac, hkdfSync } from "node:crypto";
import type { HostedStanding, PrismaClient } from "@intentic/prisma";
import type { Config } from "../../../config.js";
import { DAY_MS } from "../../../durations.js";

/* A DELETED ACCOUNT'S HOSTED STANDING, CARRIED (the HostedStanding table). account-erase.ts moves the account's
 * suspension, its strike count and the month's free minutes onto a record keyed by a keyed hash of its Google subject,
 * and the suspension gate (hosted-standing.ts), the hour meter (hosted-usage.ts) and the abuse watch (hosted-abuse.ts)
 * add that record to whichever account's Google subject hashes to it. So deleting the account and signing in again
 * with the same Google account finds the hosted lane as it was left. No imports beyond the database and config, so the
 * meter can read it without a cycle. */

/* THE KEY THE GOOGLE SUBJECT IS HASHED UNDER: HKDF-SHA256 over BETTER_AUTH_SECRET with a fixed label, so no new secret
 * has to be deployed and nothing here can be read back into a subject without the platform's own. ROTATING
 * BETTER_AUTH_SECRET (which already signs every session out) ORPHANS EVERY RECORD: a returning subject hashes to a new
 * value, so until the old records expire under the retention below, a deleted account comes back clean. Changing the
 * label does the same on purpose. */
const STANDING_KEY_LABEL = `intentic hosted-standing google-subject v1`;

export const standingSubjectHash = (config: Pick<Config, "betterAuth">, googleSubject: string): string => {
    const key = Buffer.from(hkdfSync(`sha256`, config.betterAuth.secret, ``, STANDING_KEY_LABEL, 32));
    return createHmac(`sha256`, key).update(googleSubject).digest(`hex`);
};

// How long a carried suspension and strike count outlive the latest of them. The minutes go when their month ends.
export const STANDING_RETENTION_MS = 365 * DAY_MS;

// The reason a carried suspension is shown with: the record keeps no operator text, only that there was one.
export const CARRIED_SUSPENSION_REASON = `suspended on an earlier account signed in with the same Google account`;

// Added to a user read so the Google subject comes with the row instead of costing a query of its own.
export const GOOGLE_SUBJECT_SELECT = { accounts: { where: { providerId: `google` }, select: { accountId: true } } } as const;

/** The Google subject GOOGLE_SUBJECT_SELECT read, or none: absent or empty is an account with no Google sign-in. */
export const googleSubjectOf = (accounts: readonly { readonly accountId: string }[] | undefined): string | undefined => accounts?.[0]?.accountId;

/**
 * The record carried onto this account, if its Google subject hashes to one. `accounts` is what GOOGLE_SUBJECT_SELECT
 * read; absent or empty (no Google sign-in) carries nothing and asks nothing.
 */
export const carriedStandingOf = async (
    prisma: Pick<PrismaClient, "hostedStanding">,
    config: Pick<Config, "betterAuth">,
    accounts: readonly { readonly accountId: string }[] | undefined,
): Promise<HostedStanding | null> => {
    const subject = googleSubjectOf(accounts);
    return subject === undefined ? null : prisma.hostedStanding.findUnique({ where: { subjectHash: standingSubjectHash(config, subject) } });
};

/** The strikes a carried record adds to a count that starts at `since`: all of them while its latest is inside the window. */
export const carriedStrikesSince = (carried: Pick<HostedStanding, "strikes" | "standingAt"> | null, since: Date): number =>
    carried?.standingAt != null && carried.standingAt >= since ? carried.strikes : 0;

/** The free minutes a carried record adds to `month`, the calendar month (`YYYY-MM`) being counted. */
export const carriedFreeMinutes = (carried: Pick<HostedStanding, "month" | "freeMinutes"> | null, month: string): number =>
    carried?.month === month ? carried.freeMinutes : 0;

/* THE RETENTION OF CARRIED STANDING (retention.ts, daily): a suspension and strike count go twelve months after the
 * latest of them, the free minutes once their month has ended, and a record with neither left goes whole. */
export const sweepHostedStanding = async (
    prisma: Pick<PrismaClient, "hostedStanding">,
    now: Date = new Date(),
): Promise<{ standingCleared: number; minutesCleared: number; standingDropped: number }> => {
    const month = now.toISOString().slice(0, 7);
    const standing = await prisma.hostedStanding.updateMany({
        where: { standingAt: { lt: new Date(now.getTime() - STANDING_RETENTION_MS) } },
        data: { suspendedAt: null, strikes: 0, standingAt: null },
    });
    const minutes = await prisma.hostedStanding.updateMany({ where: { month: { lt: month } }, data: { month: null, freeMinutes: 0 } });
    const dropped = await prisma.hostedStanding.deleteMany({ where: { standingAt: null, month: null } });
    return { standingCleared: standing.count, minutesCleared: minutes.count, standingDropped: dropped.count };
};
