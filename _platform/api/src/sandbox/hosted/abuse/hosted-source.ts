import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../../config.js";
import { DAY_MS } from "../../../durations.js";

// Same-source caps on NEW hosted machines: how many distinct accounts one client address, and one email domain, may be
// handed a machine in a day. A machine costs money from the moment it exists and a farm of fresh Google accounts is the
// cheapest way to be handed many; a Workspace domain mints its users by the hundred. The two facts the platform has
// about "the same somebody" at that moment are counted here and nowhere else. Checked before anything is built; a row
// is written after a machine exists (HostedProvision, kept a month). An account's own earlier machines never count
// against it: release-and-provision on one account is the slot gate's business.

// Nobody's organisation: a count under these says nothing about a farm.
const PUBLIC_MAILBOXES = new Set([`gmail.com`, `googlemail.com`]);

// How far back the counts look.
const WINDOW_MS = DAY_MS;

export const emailDomain = (email: string): string => email.toLowerCase().slice(email.lastIndexOf(`@`) + 1);

// Thrown where a machine would have been built; the route answers TOO_MANY_REQUESTS in these words.
export class HostedSourceCapped extends Error {}

export interface HostedSourceArgs {
    readonly userId: string;
    readonly email: string;
    // The trusted proxy's word for the caller's address (client-ip.ts); undefined skips the address cap.
    readonly ip: string | undefined;
}

// Distinct OTHER accounts handed a machine from this source within the window.
const otherAccounts = async (
    prisma: Pick<PrismaClient, "hostedProvision">,
    where: { ip: string } | { domain: string },
    userId: string,
    since: Date,
): Promise<number> => {
    const rows = await prisma.hostedProvision.findMany({
        where: { ...where, createdAt: { gte: since }, NOT: { userId } },
        distinct: [`userId`],
        select: { userId: true },
    });
    return rows.length;
};

export const assertHostedSource = async (
    prisma: Pick<PrismaClient, "hostedProvision">,
    config: Config,
    args: HostedSourceArgs,
    now: Date = new Date(),
): Promise<void> => {
    const since = new Date(now.getTime() - WINDOW_MS);
    const { provisionsPerIpPerDay, provisionsPerDomainPerDay } = config.hosted;
    if (
        provisionsPerIpPerDay > 0 &&
        args.ip !== undefined &&
        (await otherAccounts(prisma, { ip: args.ip }, args.userId, since)) >= provisionsPerIpPerDay
    ) {
        throw new HostedSourceCapped(
            `too many hosted sandboxes were started from this network today; try again tomorrow, or set one up on your own computer, which has no limits at all`,
        );
    }
    const domain = emailDomain(args.email);
    if (
        provisionsPerDomainPerDay > 0 &&
        !PUBLIC_MAILBOXES.has(domain) &&
        (await otherAccounts(prisma, { domain }, args.userId, since)) >= provisionsPerDomainPerDay
    ) {
        throw new HostedSourceCapped(
            `too many hosted sandboxes were started for @${domain} accounts today; try again tomorrow, or set one up on your own computer, which has no limits at all`,
        );
    }
};

// Written once a machine exists, warm or cold; an address the proxy didn't give is the empty string, which no cap
// ever matches.
export const recordHostedProvision = async (
    prisma: Pick<PrismaClient, "hostedProvision">,
    args: HostedSourceArgs & { appName: string },
): Promise<void> => {
    await prisma.hostedProvision.create({
        data: { userId: args.userId, ip: args.ip ?? ``, domain: emailDomain(args.email), appName: args.appName },
    });
};
