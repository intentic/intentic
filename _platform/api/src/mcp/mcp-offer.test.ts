import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import {
    consumeGrant,
    createOffer,
    expireOffers,
    findRecentOffer,
    GRANT_TTL_MS,
    OFFER_TTL_MS,
    readOffer,
    settleOffer,
    WHY_MAX,
} from "./mcp-offer.js";

/* THE SPEND GATE'S OWN TESTS. What is being pinned here is not CRUD — it is the one property that lets a
 * coding agent on somebody's laptop be handed a spending catalogue: an approval exists only if the owner's
 * browser wrote it, and it releases exactly one run. Every test below is a way that could stop being true. */

const NOW = new Date(`2026-08-20T12:00:00Z`);
const LATER = new Date(NOW.getTime() + OFFER_TTL_MS + 1_000);

interface Row {
    id: string;
    userId: string;
    serviceId: string;
    credits: number;
    request: string;
    why: string | null;
    status: string;
    createdAt: Date;
    expiresAt: Date;
    decidedAt: Date | null;
}

// An in-memory service_offer table with the SAME conditional-update semantics the real one has — updateMany
// filtered on status returns a count, which is what makes "one approval, one run" a race-proof property
// rather than a hopeful read-then-write.
const fakePrisma = (seed: readonly Partial<Row>[] = []) => {
    const rows: Row[] = seed.map((row, index) => ({
        id: row.id ?? `o${index}`,
        userId: row.userId ?? `u1`,
        serviceId: row.serviceId ?? `s1`,
        credits: row.credits ?? 25,
        request: row.request ?? `{"q":"x"}`,
        why: row.why ?? null,
        status: row.status ?? `pending`,
        createdAt: row.createdAt ?? NOW,
        expiresAt: row.expiresAt ?? new Date(NOW.getTime() + OFFER_TTL_MS),
        decidedAt: row.decidedAt ?? null,
    }));
    let next = rows.length;

    // The subset of Prisma's `where` this module actually uses, evaluated honestly enough that a filter the
    // production code relies on cannot silently pass here.
    const matches = (row: Row, where: Record<string, unknown>): boolean =>
        Object.entries(where).every(([field, condition]) => {
            if (field === `OR`) {
                return (condition as Record<string, unknown>[]).some((clause) => matches(row, clause));
            }
            const value = row[field as keyof Row];
            if (condition !== null && typeof condition === `object`) {
                const test = condition as { in?: string[]; gt?: Date; lte?: Date };
                if (test.in !== undefined) {
                    return test.in.includes(value as string);
                }
                if (test.gt !== undefined) {
                    return value instanceof Date && value > test.gt;
                }
                if (test.lte !== undefined) {
                    return value instanceof Date && value <= test.lte;
                }
                return false;
            }
            return value === condition;
        });

    const serviceOffer = {
        create: vi.fn(async ({ data }: { data: Omit<Row, `id` | `status` | `createdAt` | `decidedAt` | `why`> & { why?: string } }) => {
            const row: Row = {
                id: `o${next++}`,
                userId: data.userId,
                serviceId: data.serviceId,
                credits: data.credits,
                request: data.request,
                why: data.why ?? null,
                status: `pending`,
                createdAt: NOW,
                expiresAt: data.expiresAt,
                decidedAt: null,
            };
            rows.push(row);
            return row;
        }),
        findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { createdAt: string } }) => {
            const found = rows.filter((row) => matches(row, where));
            if (orderBy?.createdAt === `desc`) {
                found.reverse();
            }
            const row = found[0];
            return row === undefined
                ? null
                : { ...row, service: { id: row.serviceId, slug: `demo`, name: `Demo`, publisher: `intentic`, description: `d`, status: `listed` } };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
            const hit = rows.filter((row) => matches(row, where));
            for (const row of hit) {
                Object.assign(row, data);
            }
            return { count: hit.length };
        }),
    };
    return { prisma: { serviceOffer } as unknown as PrismaClient, rows };
};

describe(`the offer's lifecycle`, () => {
    it(`writes a pending row with the price stamped on it and the why capped`, async () => {
        const { prisma, rows } = fakePrisma();
        const id = await createOffer(prisma, { userId: `u1`, serviceId: `s1`, credits: 25, request: `{"q":"x"}`, why: `w`.repeat(400) }, NOW);
        const row = rows.find((entry) => entry.id === id);
        expect(row).toMatchObject({ status: `pending`, credits: 25 });
        expect(row?.why).toHaveLength(WHY_MAX);
        expect(row?.expiresAt.getTime()).toBe(NOW.getTime() + OFFER_TTL_MS);
    });

    it(`drops a blank why rather than storing an empty line`, async () => {
        const { prisma, rows } = fakePrisma();
        const id = await createOffer(prisma, { userId: `u1`, serviceId: `s1`, credits: 5, request: `{}`, why: `   ` }, NOW);
        expect(rows.find((entry) => entry.id === id)?.why).toBeNull();
    });

    it(`reads a lapsed offer as expired without having written anything`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1` }]);
        expect((await readOffer(prisma, `o1`, `u1`, LATER))?.status).toBe(`expired`);
        // The page said the true thing; the row is still literally pending until the sweep runs.
        expect(rows[0]?.status).toBe(`pending`);
    });

    it(`refuses to show another account's offer at all`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, userId: `u1` }]);
        expect(await readOffer(prisma, `o1`, `someone-else`, NOW)).toBeUndefined();
    });
});

describe(`settling — the only door to approved`, () => {
    it(`approves a live offer once, and reads a second click as already settled`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1` }]);
        expect(await settleOffer(prisma, `o1`, `u1`, true, NOW)).toBe(`approved`);
        expect(rows[0]?.status).toBe(`approved`);
        expect(await settleOffer(prisma, `o1`, `u1`, true, NOW)).toBe(`already_settled`);
    });

    it(`declines without charging, and stamps when`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1` }]);
        expect(await settleOffer(prisma, `o1`, `u1`, false, NOW)).toBe(`declined`);
        expect(rows[0]).toMatchObject({ status: `declined`, decidedAt: NOW });
    });

    it(`will not approve an offer that ran out while the page was open`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1` }]);
        expect(await settleOffer(prisma, `o1`, `u1`, true, LATER)).toBe(`expired`);
        expect(rows[0]?.status).toBe(`expired`);
    });

    it(`cannot be driven by another account`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1`, userId: `u1` }]);
        expect(await settleOffer(prisma, `o1`, `intruder`, true, NOW)).toBe(`unknown`);
        expect(rows[0]?.status).toBe(`pending`);
    });
});

describe(`consuming the grant — one approval, one run`, () => {
    it(`spends an approved offer and refuses the second attempt`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `approved`, request: `{"q":"x"}` }]);
        const first = await consumeGrant(prisma, `o1`, `u1`, NOW);
        expect(first).toMatchObject({ kind: `granted`, request: `{"q":"x"}`, credits: 25 });
        expect((await consumeGrant(prisma, `o1`, `u1`, NOW)).kind).toBe(`already_spent`);
    });

    /* THE LOAD-BEARING ONE. This is what a Claude Code `Elicitation` hook that auto-answers the dialog buys:
     * nothing. The client's answer never touches this table, so the run finds a pending row and refuses. */
    it(`refuses a pending offer no matter who says the user consented`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `pending` }]);
        expect((await consumeGrant(prisma, `o1`, `u1`, NOW)).kind).toBe(`pending`);
    });

    it(`refuses a declined offer, and one whose ask lapsed unanswered`, async () => {
        const declined = fakePrisma([{ id: `o1`, status: `declined` }]);
        expect((await consumeGrant(declined.prisma, `o1`, `u1`, NOW)).kind).toBe(`declined`);
        const stale = fakePrisma([{ id: `o1`, status: `pending`, expiresAt: new Date(NOW.getTime() - 1) }]);
        expect((await consumeGrant(stale.prisma, `o1`, `u1`, NOW)).kind).toBe(`expired`);
    });

    /* A yes is consent to spend NOW. The retry it exists for lands in seconds; a grant found hours later
     * belongs to a conversation that is over, and spending it would surprise the person who gave it. */
    it(`lets an approval go cold, and marks the row so it stops reading as live`, async () => {
        const { prisma, rows } = fakePrisma([{ id: `o1`, status: `approved`, decidedAt: NOW }]);
        const wayLater = new Date(NOW.getTime() + GRANT_TTL_MS + 1_000);
        expect((await consumeGrant(prisma, `o1`, `u1`, wayLater)).kind).toBe(`expired`);
        expect(rows[0]?.status).toBe(`expired`);
    });

    it(`still spends a fresh approval whose ASK clock has passed — ten minutes bounds the question, not the yes`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `approved`, decidedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }]);
        expect((await consumeGrant(prisma, `o1`, `u1`, NOW)).kind).toBe(`granted`);
    });

    it(`refuses another account's approved offer`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, userId: `u1`, status: `approved` }]);
        expect((await consumeGrant(prisma, `o1`, `intruder`, NOW)).kind).toBe(`unknown`);
    });
});

describe(`how a retry finds its own offer`, () => {
    it(`re-opens the same pending card for an identical request`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, request: `{"q":"x"}` }]);
        expect(await findRecentOffer(prisma, { userId: `u1`, serviceId: `s1`, request: `{"q":"x"}` }, NOW)).toMatchObject({
            id: `o1`,
            status: `pending`,
        });
    });

    it(`finds nothing for a different body, so a different ask gets its own card`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, request: `{"q":"x"}` }]);
        expect(await findRecentOffer(prisma, { userId: `u1`, serviceId: `s1`, request: `{"q":"y"}` }, NOW)).toBeUndefined();
    });

    it(`still reports a just-declined offer, so the answer "no" is said once instead of re-asked`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `declined`, decidedAt: NOW }]);
        expect((await findRecentOffer(prisma, { userId: `u1`, serviceId: `s1`, request: `{"q":"x"}` }, NOW))?.status).toBe(`declined`);
    });

    it(`forgets a decline once the grace window passes, so asking again later raises a fresh card`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `declined`, decidedAt: NOW }]);
        const muchLater = new Date(NOW.getTime() + 10 * 60_000);
        expect(await findRecentOffer(prisma, { userId: `u1`, serviceId: `s1`, request: `{"q":"x"}` }, muchLater)).toBeUndefined();
    });

    /* A run that already happened must never make the NEXT identical ask look answered — otherwise a second
     * run of the same query would silently reuse a spent approval instead of asking again. */
    it(`never returns a spent offer`, async () => {
        const { prisma } = fakePrisma([{ id: `o1`, status: `spent`, decidedAt: NOW }]);
        expect(await findRecentOffer(prisma, { userId: `u1`, serviceId: `s1`, request: `{"q":"x"}` }, NOW)).toBeUndefined();
    });
});

describe(`the sweep`, () => {
    it(`marks abandoned offers expired and leaves settled ones alone`, async () => {
        const { prisma, rows } = fakePrisma([
            { id: `o1`, status: `pending` },
            { id: `o2`, status: `approved` },
        ]);
        expect(await expireOffers(prisma, LATER)).toBe(1);
        expect(rows.map((row) => row.status)).toEqual([`expired`, `approved`]);
    });
});
