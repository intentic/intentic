import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../context.js";
import { inviteRoutes } from "./invite.routes.js";

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
const sandboxRow = { id: `s1`, name: `dev`, image: null, ownerId: `u1`, token: `tok`, daemonUrl: null, lastSeenAt: null, tunnelToken: null };

// Minimal prisma fake: each test overrides just the calls its route makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: {
            webOrigin: `https://app.test`,
            intenticCloudflare: { apiToken: ``, zone: `` },
            secrets: { key: `` },
            email: { apiKey: ``, from: `` },
        },
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
    }) as OrpcContext;

// A platform WITH mail credentials — the only way to reach the two outcomes that exist once a send is
// attempted (refused) or deliberately skipped (a link nobody else could open).
const mailConfig = (webOrigin: string) =>
    ({
        webOrigin,
        intenticCloudflare: { apiToken: ``, zone: `` },
        secrets: { key: `` },
        email: { apiKey: `re_test`, from: `intentic <invites@app.test>` },
    }) as OrpcContext[`config`];

const expectOrpcCode = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
};

describe(`invite routes`, () => {
    it(`invite.create lowercases the invited email, mints a token, and returns the pending roster`, async () => {
        const findUnique = vi.fn().mockResolvedValue(null);
        const upsert = vi.fn().mockResolvedValue({});
        const findMany = vi.fn().mockResolvedValue([
            {
                email: `guest@example.com`,
                role: `collaborator`,
                acceptedAt: null,
                inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
                createdAt: new Date(`2020-01-01T00:00:00Z`),
            },
        ]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow) },
            sandboxMember: { findUnique, upsert, findMany },
        });

        const result = await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `Guest@Example.com`, role: `collaborator` },
            { context: context({ prisma }) },
        );

        expect(upsert).toHaveBeenCalledWith({
            where: { sandboxId_email: { sandboxId: `s1`, email: `guest@example.com` } },
            create: {
                sandboxId: `s1`,
                email: `guest@example.com`,
                role: `collaborator`,
                inviteToken: expect.any(String),
                inviteExpiresAt: expect.any(Date),
            },
            update: { role: `collaborator`, inviteToken: expect.any(String), inviteExpiresAt: expect.any(Date) },
        });
        expect(result.members).toEqual([
            {
                email: `guest@example.com`,
                role: `collaborator`,
                status: `pending`,
                invitedAt: `2020-01-01T00:00:00.000Z`,
                expiresAt: `2099-01-01T00:00:00.000Z`,
            },
        ]);
        // No mail credentials in this context: the invite still stands and the link comes back for the owner
        // to carry. `delivery` is the whole point — the caller must be able to tell that apart from a send.
        expect(result.delivery).toBe(`unconfigured`);
        expect(result.link).toMatch(/^https:\/\/app\.test\/invite\/.+/);
    });

    /* THE MAIL IS NOT THE GRANT. Both tests below cover the same regression from opposite ends: a send that
     * fails used to throw out of the handler, so the browser got a 500 over a roster that already showed the
     * person pending — reported to the user as "is the sandbox online?" about a sandbox that was fine. */
    it(`invite.create survives a refused email and hands back the link`, async () => {
        const findMany = vi.fn().mockResolvedValue([]);
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow) },
            sandboxMember: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}), findMany },
        });
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const fetchMock = vi.fn().mockResolvedValue(new Response(`nope`, { status: 422 }));
        vi.stubGlobal(`fetch`, fetchMock);

        const result = await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `guest@example.com`, role: `viewer` },
            { context: context({ prisma, logger, config: mailConfig(`https://app.test`) } as unknown as Partial<OrpcContext>) },
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(result.delivery).toBe(`refused`);
        expect(result.link).toMatch(/^https:\/\/app\.test\/invite\/.+/);
        // The refusal is an incident on the server even though the request succeeded.
        expect(logger.error).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it(`invite.create doesn't email a link that only resolves on this machine`, async () => {
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow) },
            sandboxMember: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
        });
        const fetchMock = vi.fn();
        vi.stubGlobal(`fetch`, fetchMock);

        const result = await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `guest@example.com`, role: `viewer` },
            { context: context({ prisma, config: mailConfig(`https://localhost:47145`) } as Partial<OrpcContext>) },
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.delivery).toBe(`local-link`);
        expect(result.link).toBe(`https://localhost:47145/invite/${result.link.split(`/`).pop() ?? ``}`);
        vi.unstubAllGlobals();
    });

    it(`invite.accept flips a valid invite for the invited address and is email-locked`, async () => {
        const guest = { id: `u2`, email: `Guest@Example.com`, name: `Guest`, image: null };
        const memberRow = {
            id: `m1`,
            sandboxId: `s1`,
            email: `guest@example.com`,
            acceptedAt: null,
            inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
        };
        const update = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({ sandboxMember: { findUnique: vi.fn().mockResolvedValue(memberRow), update } });

        const result = await call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma, user: guest }) });
        expect(update).toHaveBeenCalledWith({ where: { id: `m1` }, data: { acceptedAt: expect.any(Date) } });
        expect(result).toEqual({ sandboxId: `s1` });

        // A different Google account can't accept — the invite is locked to the invited email.
        const wrong = fakePrisma({ sandboxMember: { findUnique: vi.fn().mockResolvedValue(memberRow), update: vi.fn() } });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma: wrong }) }), `FORBIDDEN`);
    });

    it(`invite.accept 404s an unknown token`, async () => {
        const prisma = fakePrisma({ sandboxMember: { findUnique: vi.fn().mockResolvedValue(null) } });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `nope` }, { context: context({ prisma }) }), `NOT_FOUND`);
    });
});
