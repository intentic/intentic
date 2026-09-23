import type { PrismaClient } from "@intentic/prisma";
import { call } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { API_TOKEN_PREFIX, apiTokenDigest, verifyApiToken } from "./api-tokens.js";
import { tokenRoutes } from "./tokens.routes.js";

/* MINTING IS SESSION-ONLY, and the stored form is a digest: those two are what the whole credential rests on. */

const user = { id: `user-1`, email: `Owner@Example.test`, name: `Owner`, image: null };

const fakePrisma = (rows: Record<string, unknown>[] = []) => {
    const create = jest.fn(async ({ data }: { data: Record<string, string> }) => ({
        id: `tok-new`,
        label: data[`label`],
        scope: data[`scope`],
        createdAt: new Date(`2026-09-21T10:00:00.000Z`),
    }));
    const updateMany = jest.fn(async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 }));
    return {
        create,
        updateMany,
        prisma: {
            apiToken: {
                findMany: jest.fn(async () => rows),
                findUnique: jest.fn(async () => rows[0] ?? null),
                count: jest.fn(async () => rows.length),
                create,
                updateMany,
                update: jest.fn(async () => ({})),
            },
        } as unknown as PrismaClient,
    };
};

const context = (prisma: PrismaClient, over: Partial<OrpcContext> = {}): OrpcContext =>
    ({ prisma, user, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, ...over }) as unknown as OrpcContext;

it(`refuses to mint without a session, so a token can never mint its successor`, async () => {
    const { prisma, create } = fakePrisma();
    await expect(
        call(tokenRoutes.create, { label: `fleet`, scope: `provision` as const }, { context: context(prisma, { user: null }) }),
    ).rejects.toMatchObject({ code: `UNAUTHORIZED` });
    expect(create).not.toHaveBeenCalled();
});

it(`stores the digest and returns the raw value exactly once`, async () => {
    const { prisma, create } = fakePrisma();
    const minted = await call(tokenRoutes.create, { label: ` fleet `, scope: `provision` as const }, { context: context(prisma) });
    expect(minted.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    const written = create.mock.calls[0]?.[0].data as unknown as Record<string, string>;
    // The value itself is nowhere in the write, and the digest is what the lookup key will be.
    expect(JSON.stringify(written)).not.toContain(minted.token);
    expect(written[`hash`]).toBe(apiTokenDigest(minted.token));
    expect(written[`label`]).toBe(`fleet`);
});

it(`refuses a twenty-first live token rather than letting a page of them accumulate`, async () => {
    const { prisma, create } = fakePrisma(Array.from({ length: 20 }, (_unused, index) => ({ id: `tok-${index}` })));
    await expect(call(tokenRoutes.create, { label: `one more`, scope: `provision` as const }, { context: context(prisma) })).rejects.toMatchObject({
        code: `TOO_MANY_REQUESTS`,
    });
    expect(create).not.toHaveBeenCalled();
});

it(`revokes scoped to the caller, so a guessed id belonging to someone else writes nothing`, async () => {
    const { prisma, updateMany } = fakePrisma();
    await call(tokenRoutes.revoke, { tokenId: `someone-elses` }, { context: context(prisma) });
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: `someone-elses`, userId: `user-1`, revokedAt: null } });
});

it(`verifies only a live token of the asked-for scope, and lowercases the account it names`, async () => {
    const live = {
        id: `tok-1`,
        userId: `user-1`,
        label: `fleet`,
        scope: `provision`,
        revokedAt: null,
        lastUsedAt: null,
        user: { email: `Owner@Example.test` },
    };
    const { prisma } = fakePrisma([live]);
    await expect(verifyApiToken(prisma, `itk_whatever`, `provision`)).resolves.toMatchObject({ userId: `user-1`, email: `owner@example.test` });

    const revoked = fakePrisma([{ ...live, revokedAt: new Date() }]);
    await expect(verifyApiToken(revoked.prisma, `itk_whatever`, `provision`)).resolves.toBeUndefined();

    // An empty presentation never reaches the database: the digest of "" is a real digest and would be a real lookup.
    const empty = fakePrisma([live]);
    await expect(verifyApiToken(empty.prisma, ``, `provision`)).resolves.toBeUndefined();
    expect(empty.prisma.apiToken.findUnique).not.toHaveBeenCalled();
});
