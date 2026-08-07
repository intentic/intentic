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

        const result = await call(inviteRoutes.create, { sandboxId: `s1`, email: `Guest@Example.com`, role: `collaborator` }, { context: context({ prisma }) });

        expect(upsert).toHaveBeenCalledWith({
            where: { sandboxId_email: { sandboxId: `s1`, email: `guest@example.com` } },
            create: { sandboxId: `s1`, email: `guest@example.com`, role: `collaborator`, inviteToken: expect.any(String), inviteExpiresAt: expect.any(Date) },
            update: { role: `collaborator`, inviteToken: expect.any(String), inviteExpiresAt: expect.any(Date) },
        });
        expect(result.members).toEqual([
            { email: `guest@example.com`, role: `collaborator`, status: `pending`, invitedAt: `2020-01-01T00:00:00.000Z`, expiresAt: `2099-01-01T00:00:00.000Z` },
        ]);
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
