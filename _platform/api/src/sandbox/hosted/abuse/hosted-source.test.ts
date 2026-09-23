import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../../config.js";
import { assertHostedSource, emailDomain, HostedSourceCapped, recordHostedProvision } from "./hosted-source.js";

// The caps count OTHER accounts handed a machine from the same address or domain in a day; the caller's own rows,
// gmail's domain, an unknown address and a cap at 0 all count nothing.

const NOW = new Date(`2026-09-14T12:00:00.000Z`);

const config = (over: Record<string, unknown> = {}): Config =>
    ({ hosted: { provisionsPerIpPerDay: 3, provisionsPerDomainPerDay: 10, ...over } }) as unknown as Config;

interface Row {
    readonly userId: string;
    readonly ip: string;
    readonly domain: string;
    readonly createdAt: Date;
}

// Enough of Prisma's findMany to honour the where the module writes: source, window and the NOT on the caller.
const prismaWith = (rows: Row[]) => {
    const findMany = jest.fn(async ({ where }: { where: { ip?: string; domain?: string; createdAt: { gte: Date }; NOT: { userId: string } } }) =>
        [
            ...new Set(
                rows
                    .filter((row) => (where.ip === undefined || row.ip === where.ip) && (where.domain === undefined || row.domain === where.domain))
                    .filter((row) => row.createdAt >= where.createdAt.gte && row.userId !== where.NOT.userId)
                    .map((row) => row.userId),
            ),
        ].map((userId) => ({ userId })),
    );
    const create = jest.fn().mockResolvedValue({});
    return { prisma: { hostedProvision: { findMany, create } } as unknown as PrismaClient, findMany, create };
};

const row = (userId: string, over: Partial<Row> = {}): Row => ({
    userId,
    ip: `203.0.113.7`,
    domain: `acme.example`,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
});

const capped = async (promise: Promise<unknown>): Promise<string | undefined> =>
    promise.then(
        () => undefined,
        (error: unknown) => (error instanceof HostedSourceCapped ? error.message : `not the cap: ${String(error)}`),
    );

describe(`the same-source caps`, () => {
    it(`reads the domain off the address, case-folded`, () => {
        expect(emailDomain(`Dev@Acme.Example`)).toBe(`acme.example`);
    });

    it(`refuses the fourth account from one address in a day, naming the way through`, async () => {
        const { prisma } = prismaWith([row(`a`), row(`b`), row(`c`)]);
        const refusal = await capped(assertHostedSource(prisma, config(), { userId: `d`, email: `d@gmail.com`, ip: `203.0.113.7` }, NOW));
        expect(refusal).toContain(`this network`);
        expect(refusal).toContain(`your own computer`);
    });

    it(`admits the third, and the same account again however many times`, async () => {
        const { prisma } = prismaWith([row(`a`), row(`b`), row(`c`, { createdAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000) })]);
        await expect(assertHostedSource(prisma, config(), { userId: `d`, email: `d@gmail.com`, ip: `203.0.113.7` }, NOW)).resolves.toBeUndefined();
        const { prisma: own } = prismaWith([row(`a`), row(`a`), row(`a`), row(`a`)]);
        await expect(assertHostedSource(own, config(), { userId: `a`, email: `a@gmail.com`, ip: `203.0.113.7` }, NOW)).resolves.toBeUndefined();
    });

    it(`skips the address cap with no trusted address, and reads nothing with the cap at 0`, async () => {
        const { prisma, findMany } = prismaWith([row(`a`), row(`b`), row(`c`)]);
        await expect(assertHostedSource(prisma, config(), { userId: `d`, email: `d@gmail.com`, ip: undefined }, NOW)).resolves.toBeUndefined();
        await expect(
            assertHostedSource(
                prisma,
                config({ provisionsPerIpPerDay: 0, provisionsPerDomainPerDay: 0 }),
                { userId: `d`, email: `d@acme.example`, ip: `203.0.113.7` },
                NOW,
            ),
        ).resolves.toBeUndefined();
        expect(findMany).not.toHaveBeenCalled();
    });

    it(`refuses the eleventh account on one organisation's domain, and never counts gmail`, async () => {
        const many = Array.from({ length: 10 }, (_, index) => row(`u${index}`, { ip: `198.51.100.${index}` }));
        const { prisma } = prismaWith(many);
        expect(await capped(assertHostedSource(prisma, config(), { userId: `new`, email: `new@acme.example`, ip: `198.51.100.99` }, NOW))).toContain(
            `@acme.example`,
        );
        const { prisma: gmail } = prismaWith(many.map((entry) => ({ ...entry, domain: `gmail.com` })));
        await expect(
            assertHostedSource(gmail, config(), { userId: `new`, email: `new@gmail.com`, ip: `198.51.100.99` }, NOW),
        ).resolves.toBeUndefined();
    });

    it(`records a provision with its source, an absent address as the empty string`, async () => {
        const { prisma, create } = prismaWith([]);
        await recordHostedProvision(prisma, { userId: `a`, email: `A@Acme.Example`, ip: undefined, appName: `intentic-sbx-1` });
        expect(create).toHaveBeenCalledWith({ data: { userId: `a`, ip: ``, domain: `acme.example`, appName: `intentic-sbx-1` } });
    });
});
