import { createHmac, hkdfSync } from "node:crypto";
import type { HostedStanding, PrismaClient } from "@intentic/prisma";
import type { Config } from "../../../config.js";
import { DAY_MS } from "../../../durations.js";

/* A DELETED ACCOUNT'S HOSTED STANDING, CARRIED (the HostedStanding table). account-erase.ts moves the account's
 * suspension, its strike count and the month's free minutes onto records keyed by a keyed hash of its Google subject
 * and of its canonical email address, and the suspension gate (hosted-standing.ts), the hour meter (hosted-usage.ts)
 * and the abuse watch (hosted-abuse.ts) add those records to whichever account's subject or address hashes to one. So
 * deleting the account and signing in again with the same Google account, or with a code to the same address (an alias
 * of it included), finds the hosted lane as it was left. No imports beyond the database and config, so the meter can
 * read it without a cycle. (2026-10-12) The address key came with email sign-in: an account that signs in with a code
 * has no Google subject, and keyed only by that, its suspension went with a delete. */

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

// The address key's own label, so an address can never hash to the record of a Google subject that happens to equal it.
const EMAIL_STANDING_KEY_LABEL = `intentic hosted-standing email v1`;

// Mailboxes that ignore dots in the local part, so `a.da@` and `ada@` are one inbox there and one key here.
const DOTLESS_MAILBOXES = new Set([`gmail.com`, `googlemail.com`]);

/** One mailbox's address however it was spelled: lowercased, a `+tag` dropped, and dots dropped where the provider
 * ignores them. Only ever a key for standing, never an identity: two addresses that canonicalise alike are still two
 * accounts, they just share a record of how the hosted lane was used. */
export const canonicalEmail = (email: string): string => {
    const address = email.trim().toLowerCase();
    const at = address.lastIndexOf(`@`);
    if (at <= 0) {
        return address;
    }
    const domain = address.slice(at + 1) === `googlemail.com` ? `gmail.com` : address.slice(at + 1);
    const untagged = address.slice(0, at).split(`+`)[0] ?? ``;
    const local = DOTLESS_MAILBOXES.has(domain) ? untagged.replaceAll(`.`, ``) : untagged;
    return `${local}@${domain}`;
};

export const standingEmailHash = (config: Pick<Config, "betterAuth">, email: string): string => {
    const key = Buffer.from(hkdfSync(`sha256`, config.betterAuth.secret, ``, EMAIL_STANDING_KEY_LABEL, 32));
    return createHmac(`sha256`, key).update(canonicalEmail(email)).digest(`hex`);
};

/** Every key an account's standing is carried under: its Google subject's, when it has one, and its address's. */
export const standingKeysOf = (config: Pick<Config, "betterAuth">, owner: { readonly subject?: string | undefined; readonly email?: string | undefined }): string[] => {
    const keys: string[] = [];
    if (owner.subject !== undefined && owner.subject !== ``) {
        keys.push(standingSubjectHash(config, owner.subject));
    }
    if (owner.email !== undefined && owner.email !== ``) {
        keys.push(standingEmailHash(config, owner.email));
    }
    return keys;
};

/** One standing out of the records found under an account's keys. The same history can sit under both of them, so each
 * part is the larger, never the sum: a suspension if either holds one, the most strikes, the latest month's minutes. */
export const mergeStanding = (records: readonly (HostedStanding | null)[]): HostedStanding | null => {
    const found = records.filter((record): record is HostedStanding => record !== null);
    const [first] = found;
    if (first === undefined) {
        return null;
    }
    const latestOf = (moments: readonly (Date | null)[]): Date | null =>
        moments.reduce<Date | null>((best, at) => (at !== null && (best === null || at > best) ? at : best), null);
    const month = found.map((record) => record.month).reduce<string | null>((best, at) => (at !== null && (best === null || at > best) ? at : best), null);
    return {
        ...first,
        suspendedAt: latestOf(found.map((record) => record.suspendedAt)),
        strikes: Math.max(...found.map((record) => record.strikes)),
        standingAt: latestOf(found.map((record) => record.standingAt)),
        month,
        freeMinutes: Math.max(0, ...found.map((record) => (month !== null && record.month === month ? record.freeMinutes : 0))),
    };
};

// How long a carried suspension and strike count outlive the latest of them. The minutes go when their month ends.
export const STANDING_RETENTION_MS = 365 * DAY_MS;

// The reason a carried suspension is shown with: the record keeps no operator text, only that there was one.
export const CARRIED_SUSPENSION_REASON = `suspended on an earlier account signed in with the same Google account or email address`;

// Added to a user read so the Google subject comes with the row instead of costing a query of its own.
export const GOOGLE_SUBJECT_SELECT = { accounts: { where: { providerId: `google` }, select: { accountId: true } } } as const;

/** The Google subject GOOGLE_SUBJECT_SELECT read, or none: absent or empty is an account with no Google sign-in. */
export const googleSubjectOf = (accounts: readonly { readonly accountId: string }[] | undefined): string | undefined => accounts?.[0]?.accountId;

/**
 * The standing carried onto this account, if its Google subject or its address hashes to a record. `accounts` is what
 * GOOGLE_SUBJECT_SELECT read; absent or empty (no Google sign-in) leaves the address alone to ask with.
 */
export const carriedStandingOf = async (
    prisma: Pick<PrismaClient, "hostedStanding">,
    config: Pick<Config, "betterAuth">,
    accounts: readonly { readonly accountId: string }[] | undefined,
    email?: string,
): Promise<HostedStanding | null> => {
    const keys = standingKeysOf(config, { subject: googleSubjectOf(accounts), email });
    return mergeStanding(await Promise.all(keys.map((subjectHash) => prisma.hostedStanding.findUnique({ where: { subjectHash } }))));
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
