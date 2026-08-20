import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { LIVE_STATUSES } from "./pool-admission.js";
import { creditStatus, type CreditStatus } from "./pool-credits.js";
import { premiumOf } from "./pool-membership.js";

/* THE CATALOG READ AND THE DEMAND WRITE, without a transport — the two halves of "what can I ask for, and
 * what did I fail to find", lifted out of pool.routes.ts for the same reason pool-run.ts was: two surfaces
 * drive them now (the sandbox daemon over HTTP, the MCP server in-process) and neither should be able to show
 * a different catalog or count a want differently. */

export interface CatalogListing {
    readonly slug: string;
    readonly publisher: string;
    readonly name: string;
    readonly description: string;
    readonly creditsPerRun: number;
    // True while a listing is still in open admission's probation — live, price-capped, and badged `new`.
    readonly probation: boolean;
    // A request body the provider published as a worked example of their service's shape. Agent-facing
    // documentation: an agent composing a body with one of these in front of it writes a better one.
    readonly sampleRequest: string;
}

export interface CatalogAnswer {
    readonly member: boolean;
    readonly services: readonly CatalogListing[];
    // Only a member has a meter, because only a member has an allowance.
    readonly credits?: CreditStatus;
}

/* Everyone with an account sees the catalog — someone deciding whether to join should be able to read what
 * membership buys before they pay for it, which is exactly the case an MCP client arrives in. */
export const readServiceCatalog = async (prisma: PrismaClient, config: Config, ownerId: string, now: Date): Promise<CatalogAnswer> => {
    const [rows, member] = await Promise.all([
        prisma.service.findMany({
            where: { status: { in: [...LIVE_STATUSES] } },
            select: { slug: true, publisher: true, name: true, description: true, creditsPerRun: true, status: true, sampleRequest: true },
            orderBy: { slug: `asc` },
        }),
        premiumOf(prisma, config, ownerId),
    ]);
    /* Written out field by field rather than spread, so this reads as what it is: the wire shape, stated once.
     * `probation` is flattened to one boolean rather than leaking the status vocabulary to every reader — what
     * a member's card needs to say is "this listing is new", and what an agent needs to know is nothing at all
     * beyond preferring an established service when both would answer. */
    const services = rows.map((row) => ({
        slug: row.slug,
        publisher: row.publisher,
        name: row.name,
        description: row.description,
        creditsPerRun: row.creditsPerRun,
        probation: row.status === `probation`,
        sampleRequest: row.sampleRequest,
    }));
    const credits = member ? await creditStatus(prisma, config, ownerId, now) : undefined;
    return { member, services, ...(credits !== undefined ? { credits } : {}) };
};

/* The wanted list's bounds. Short enough to stay a capability description rather than a task dump (the skill
 * tells agents exactly that), long enough to say "watermark-free PDF invoice extraction with line items". The
 * daily cap bounds one noisy sandbox; the public aggregate counts distinct owners for the same reason. */
export const WANT_MIN = 8;
export const WANT_MAX = 200;
export const WANTS_PER_DAY = 5;

// The grouping key: "PDF invoices" and "pdf  invoices" are one ask, not two rows on the public list.
export const normalizedWant = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ` `);

export type WantOutcome = { readonly kind: `recorded` } | { readonly kind: `malformed` } | { readonly kind: `rate_limited` };

/* ONE "THE CATALOG HAD NOTHING FOR THIS". Costs nothing, needs no membership (a non-member's unmet need is
 * future demand), raises no card, and returns nothing about anyone — it is a note to providers, published only
 * in aggregate. The owner column exists to bound the writer and is never published. */
export const fileServiceWant = async (prisma: PrismaClient, ownerId: string, raw: string, now: Date): Promise<WantOutcome> => {
    const text = raw.trim();
    if (text.length < WANT_MIN || text.length > WANT_MAX) {
        return { kind: `malformed` };
    }
    const today = await prisma.serviceWant.count({
        where: { userId: ownerId, createdAt: { gte: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`) } },
    });
    if (today >= WANTS_PER_DAY) {
        return { kind: `rate_limited` };
    }
    await prisma.serviceWant.create({ data: { userId: ownerId, text, normalized: normalizedWant(text) } });
    return { kind: `recorded` };
};
