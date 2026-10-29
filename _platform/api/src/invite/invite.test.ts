import { call, ORPCError } from "@orpc/server";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { SandboxMember } from "@intentic/prisma";
import type { OrpcContext } from "../context.js";
import { inviteRoutes } from "./invite.routes.js";

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null, emailVerified: true };
const sandboxRow = {
    id: `s1`,
    name: `dev`,
    image: null,
    ownerId: `u1`,
    token: `tok`,
    daemonUrl: null,
    lastSeenAt: null,
    tunnelToken: null,
    orgId: null,
};

// Minimal prisma fake: each test overrides just the calls its route makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

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
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        ...overrides,
    }) as OrpcContext;

// A platform with mail credentials: the only way to reach the refused or deliberately-skipped outcomes.
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
    if (!(error instanceof ORPCError)) {
        throw new Error(`expected an ORPCError`);
    }
    expect(error.code).toBe(code);
    return error;
};

describe(`invite routes`, () => {
    it(`invite.create lowercases the invited email, mints a token, and returns the pending roster`, async () => {
        const findUnique = jest.fn().mockResolvedValue(null);
        const upsert = jest.fn().mockResolvedValue({});
        const findMany = jest.fn().mockResolvedValue([
            {
                email: `guest@example.com`,
                role: `collaborator`,
                manages: [],
                acceptedAt: null,
                inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
                createdAt: new Date(`2020-01-01T00:00:00Z`),
            },
        ]);
        const prisma = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue(sandboxRow) },
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
                manages: [],
                inviteToken: expect.any(String),
                inviteExpiresAt: expect.any(Date),
            },
            update: { role: `collaborator`, manages: [], inviteToken: expect.any(String), inviteExpiresAt: expect.any(Date) },
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
        // No mail credentials: the invite still stands and the link comes back for the owner to carry instead.
        expect(result.delivery).toBe(`unconfigured`);
        expect(result.link).toMatch(/^https:\/\/app\.test\/invite\/.+/);
    });

    // A failed send must not throw: it would 500 the request over a roster that already shows the person pending.
    it(`invite.create survives a refused email and hands back the link`, async () => {
        const findMany = jest.fn().mockResolvedValue([]);
        const prisma = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue(sandboxRow) },
            sandboxMember: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}), findMany },
        });
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const fetchMock = jest.fn().mockResolvedValue(new Response(`nope`, { status: 422 }));
        stubGlobal(`fetch`, fetchMock);

        const result = await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `guest@example.com`, role: `viewer` },
            { context: context({ prisma, logger, config: mailConfig(`https://app.test`) } as unknown as Partial<OrpcContext>) },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.delivery).toBe(`refused`);
        expect(result.link).toMatch(/^https:\/\/app\.test\/invite\/.+/);
        // The provider's own error, carried to the owner rather than left in a server-side log.
        expect(result.reason).toContain(`422`);
        // Still an incident on the server; the recipient and the provider's error are what make the log worth reading.
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything(), to: `guest@example.com` }), expect.any(String));
        unstubAllGlobals();
    });

    it(`invite.create doesn't email a link that only resolves on this machine`, async () => {
        const prisma = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue(sandboxRow) },
            sandboxMember: {
                findUnique: jest.fn().mockResolvedValue(null),
                upsert: jest.fn().mockResolvedValue({}),
                findMany: jest.fn().mockResolvedValue([]),
            },
        });
        const fetchMock = jest.fn();
        stubGlobal(`fetch`, fetchMock);

        const result = await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `guest@example.com`, role: `viewer` },
            { context: context({ prisma, config: mailConfig(`https://localhost:47145`) } as Partial<OrpcContext>) },
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.delivery).toBe(`local-link`);
        expect(result.link).toBe(`https://localhost:47145/invite/${result.link.split(`/`).pop() ?? ``}`);
        unstubAllGlobals();
    });

    it(`invite.accept flips a valid invite for the invited address and is email-locked`, async () => {
        const guest = { id: `u2`, email: `Guest@Example.com`, name: `Guest`, image: null, emailVerified: true };
        const memberRow = {
            id: `m1`,
            sandboxId: `s1`,
            email: `guest@example.com`,
            acceptedAt: null,
            inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
        };
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({ sandboxMember: { findUnique: jest.fn().mockResolvedValue(memberRow), updateMany } });

        const result = await call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma, user: guest }) });
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                id: `m1`,
                inviteToken: `tok`,
                email: `guest@example.com`,
                acceptedAt: null,
                OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gte: expect.any(Date) } }],
            },
            data: { acceptedAt: expect.any(Date) },
        });
        expect(result).toEqual({ sandboxId: `s1` });

        // A different Google account can't accept: the invite is locked to the invited email.
        const wrong = fakePrisma({ sandboxMember: { findUnique: jest.fn().mockResolvedValue(memberRow), updateMany: jest.fn() } });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma: wrong }) }), `FORBIDDEN`);
    });

    it(`invite.accept 404s an unknown token`, async () => {
        const prisma = fakePrisma({ sandboxMember: { findUnique: jest.fn().mockResolvedValue(null) } });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `nope` }, { context: context({ prisma }) }), `NOT_FOUND`);
    });

    it(`invite.accept refuses another account even after the invite was accepted`, async () => {
        const prisma = fakePrisma({
            sandboxMember: {
                findUnique: jest.fn().mockResolvedValue({
                    id: `m1`,
                    sandboxId: `s1`,
                    email: `guest@example.com`,
                    acceptedAt: new Date(),
                    inviteExpiresAt: null,
                }),
            },
        });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma }) }), `FORBIDDEN`);
    });

    it(`invite.accept cannot spend a link rotated after its lookup`, async () => {
        const stored: Pick<SandboxMember, `id` | `sandboxId` | `email` | `inviteToken` | `acceptedAt` | `inviteExpiresAt`> = {
            id: `m1`,
            sandboxId: `s1`,
            email: user.email,
            inviteToken: `tok`,
            acceptedAt: null,
            inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
        };
        const findUnique = jest.fn(async ({ where }: { where: { inviteToken: string } }) => {
            if (where.inviteToken !== stored.inviteToken) {
                return null;
            }
            const snapshot = { ...stored };
            // A resend commits after the SELECT took its snapshot, before the acceptance write can run.
            stored.inviteToken = `renewed-token`;
            return snapshot;
        });
        const update = jest.fn(async ({ data }: { data: { acceptedAt: Date } }) => Object.assign(stored, data));
        const updateMany = jest.fn(async ({ where, data }: { where: { inviteToken: string }; data: { acceptedAt: Date } }) => {
            if (where.inviteToken !== stored.inviteToken) {
                return { count: 0 };
            }
            Object.assign(stored, data);
            return { count: 1 };
        });
        const prisma = fakePrisma({ sandboxMember: { findUnique, update, updateMany } });
        await expectOrpcCode(call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma }) }), `CONFLICT`);
        expect(stored.inviteToken).toBe(`renewed-token`);
        expect(stored.acceptedAt).toBeNull();
    });

    it(`invite.accept remains idempotent when another acceptance wins the write`, async () => {
        const member = { id: `m1`, sandboxId: `s1`, email: user.email, acceptedAt: null, inviteExpiresAt: null };
        const prisma = fakePrisma({
            sandboxMember: {
                findUnique: jest
                    .fn()
                    .mockResolvedValueOnce(member)
                    .mockResolvedValueOnce({ ...member, acceptedAt: new Date() }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
        });
        expect(await call(inviteRoutes.accept, { token: `tok` }, { context: context({ prisma }) })).toEqual({ sandboxId: `s1` });
    });

    it(`invite.preview names the tier the link grants, so the accept page can say what is being accepted`, async () => {
        const memberRow = {
            email: `guest@example.com`,
            role: `viewer`,
            acceptedAt: null,
            inviteExpiresAt: new Date(`2099-01-01T00:00:00Z`),
            sandbox: sandboxRow,
        };
        const prisma = fakePrisma({ sandboxMember: { findUnique: jest.fn().mockResolvedValue(memberRow) } });
        expect(await call(inviteRoutes.preview, { token: `tok` }, { context: context({ prisma }) })).toEqual({
            status: `pending`,
            sandboxName: `dev`,
            invitedEmail: `guest@example.com`,
            role: `viewer`,
        });
    });

    it(`invite.preview exposes nothing at all for a token it does not know`, async () => {
        const prisma = fakePrisma({ sandboxMember: { findUnique: jest.fn().mockResolvedValue(null) } });
        expect(await call(inviteRoutes.preview, { token: `nope` }, { context: context({ prisma }) })).toEqual({ status: `invalid` });
    });
});

// A roster row as the mirror stores it; accepted unless said otherwise.
const memberRow = (email: string, role: string, options: { manages?: string[]; accepted?: boolean } = {}) => ({
    id: `m-${email}`,
    sandboxId: `s1`,
    email,
    role,
    manages: options.manages ?? [],
    inviteToken: null,
    inviteExpiresAt: null,
    acceptedAt: options.accepted === false ? null : new Date(`2020-01-02T00:00:00Z`),
    createdAt: new Date(`2020-01-01T00:00:00Z`),
});
type MemberFixture = ReturnType<typeof memberRow>;

const signedIn = (email: string) => ({ id: `u9`, email, name: `Member`, image: null, emailVerified: true });

// A sandbox someone else owns, whose roster serves both the guard's lookup of the caller and the route's of the target.
const rosterOf = (rows: MemberFixture[]) => {
    const byEmail = new Map(rows.map((row) => [row.email, row]));
    const upsert = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = fakePrisma({
        sandbox: { findUnique: jest.fn().mockResolvedValue(sandboxRow) },
        sandboxMember: {
            findUnique: jest.fn(
                async ({ where }: { where: { sandboxId_email: { email: string } } }) => byEmail.get(where.sandboxId_email.email) ?? null,
            ),
            findMany: jest.fn().mockResolvedValue(rows),
            upsert,
            update,
            deleteMany,
        },
    });
    return { prisma, upsert, update, deleteMany };
};

const asCaller = (email: string, prisma: OrpcContext[`prisma`]) => ({ context: context({ prisma, user: signedIn(email) }) });

describe(`invite routes for someone other than the owner`, () => {
    const lead = `lead@example.com`;
    const helper = `helper@example.com`;

    it(`Full access runs the roster as the owner does, their own row included`, async () => {
        const { prisma, upsert, update, deleteMany } = rosterOf([memberRow(lead, `maintainer`), memberRow(`dev@example.com`, `collaborator`)]);

        await call(inviteRoutes.create, { sandboxId: `s1`, email: `new@example.com`, role: `maintainer` }, asCaller(lead, prisma));
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: expect.objectContaining({ email: `new@example.com`, role: `maintainer`, manages: [] }) }),
        );

        await call(inviteRoutes.setRole, { sandboxId: `s1`, email: `dev@example.com`, role: `writer`, manages: [`secrets`] }, asCaller(lead, prisma));
        expect(update).toHaveBeenLastCalledWith({ where: { id: `m-dev@example.com` }, data: { role: `writer`, manages: [`secrets`] } });

        await call(inviteRoutes.setRole, { sandboxId: `s1`, email: lead, role: `collaborator` }, asCaller(lead, prisma));
        expect(update).toHaveBeenLastCalledWith({ where: { id: `m-${lead}` }, data: { role: `collaborator`, manages: [] } });

        // Revoking their own row is them leaving.
        await call(inviteRoutes.revoke, { sandboxId: `s1`, email: lead }, asCaller(lead, prisma));
        expect(deleteMany).toHaveBeenCalledWith({ where: { sandboxId: `s1`, email: lead } });
    });

    it(`People & access invites below Full access and hands out the rights it holds`, async () => {
        const { prisma, upsert } = rosterOf([memberRow(helper, `collaborator`, { manages: [`people`] })]);

        const listed = await call(inviteRoutes.list, { sandboxId: `s1` }, asCaller(helper, prisma));
        expect(listed.members[0]).toEqual(expect.objectContaining({ email: helper, role: `collaborator`, manages: [`people`] }));

        const sent = await call(inviteRoutes.create, { sandboxId: `s1`, email: `Guest@Example.com`, role: `viewer` }, asCaller(helper, prisma));
        expect(sent.delivery).toBe(`unconfigured`);
        expect(upsert).toHaveBeenLastCalledWith(
            expect.objectContaining({ create: expect.objectContaining({ email: `guest@example.com`, role: `viewer`, manages: [] }) }),
        );

        await call(
            inviteRoutes.create,
            { sandboxId: `s1`, email: `peer@example.com`, role: `collaborator`, manages: [`people`] },
            asCaller(helper, prisma),
        );
        expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ create: expect.objectContaining({ manages: [`people`] }) }));
    });

    it(`People & access never grants or touches Full access`, async () => {
        const { prisma, upsert, update, deleteMany } = rosterOf([
            memberRow(helper, `collaborator`, { manages: [`people`] }),
            memberRow(lead, `maintainer`),
            memberRow(`invited-lead@example.com`, `maintainer`, { accepted: false }),
        ]);
        const as = asCaller(helper, prisma);

        await expectOrpcCode(call(inviteRoutes.create, { sandboxId: `s1`, email: `new@example.com`, role: `maintainer` }, as), `FORBIDDEN`);
        await expectOrpcCode(call(inviteRoutes.create, { sandboxId: `s1`, email: `invited-lead@example.com`, role: `viewer` }, as), `FORBIDDEN`);
        await expectOrpcCode(call(inviteRoutes.resend, { sandboxId: `s1`, email: `invited-lead@example.com` }, as), `FORBIDDEN`);
        await expectOrpcCode(call(inviteRoutes.setRole, { sandboxId: `s1`, email: lead, role: `viewer` }, as), `FORBIDDEN`);
        await expectOrpcCode(call(inviteRoutes.revoke, { sandboxId: `s1`, email: lead }, as), `FORBIDDEN`);
        expect(upsert).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it(`People & access never changes its holder's own row`, async () => {
        const { prisma, update, deleteMany } = rosterOf([memberRow(helper, `collaborator`, { manages: [`people`] })]);

        await expectOrpcCode(call(inviteRoutes.setRole, { sandboxId: `s1`, email: helper, role: `writer` }, asCaller(helper, prisma)), `FORBIDDEN`);
        await expectOrpcCode(call(inviteRoutes.revoke, { sandboxId: `s1`, email: `Helper@Example.com` }, asCaller(helper, prisma)), `FORBIDDEN`);
        expect(update).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it(`People & access hands out only rights it holds, and keeps the ones a row already had`, async () => {
        const { prisma, upsert, update } = rosterOf([
            memberRow(helper, `collaborator`, { manages: [`people`] }),
            memberRow(`keeper@example.com`, `collaborator`, { manages: [`secrets`] }),
        ]);
        const as = asCaller(helper, prisma);

        const refused = await expectOrpcCode(
            call(inviteRoutes.create, { sandboxId: `s1`, email: `new@example.com`, role: `viewer`, manages: [`secrets`] }, as),
            `FORBIDDEN`,
        );
        expect(refused.message).toContain(`secrets`);
        expect(upsert).not.toHaveBeenCalled();

        // The row already ran its secrets; re-grading it keeps them whether the list is left out or repeated.
        await call(inviteRoutes.setRole, { sandboxId: `s1`, email: `keeper@example.com`, role: `writer` }, as);
        expect(update).toHaveBeenLastCalledWith({ where: { id: `m-keeper@example.com` }, data: { role: `writer`, manages: [`secrets`] } });
        await call(inviteRoutes.setRole, { sandboxId: `s1`, email: `keeper@example.com`, role: `writer`, manages: [`secrets`, `people`] }, as);
        expect(update).toHaveBeenLastCalledWith({ where: { id: `m-keeper@example.com` }, data: { role: `writer`, manages: [`secrets`, `people`] } });
        await expectOrpcCode(
            call(inviteRoutes.setRole, { sandboxId: `s1`, email: `keeper@example.com`, role: `writer`, manages: [`secrets`, `privacy`] }, as),
            `FORBIDDEN`,
        );
    });

    it(`anyone else reads the sandbox as not there`, async () => {
        const { prisma, upsert } = rosterOf([
            memberRow(`dev@example.com`, `collaborator`),
            memberRow(`pending@example.com`, `maintainer`, { accepted: false }),
            memberRow(`pending-helper@example.com`, `collaborator`, { manages: [`people`], accepted: false }),
        ]);
        for (const email of [`dev@example.com`, `pending@example.com`, `pending-helper@example.com`, `stranger@example.com`]) {
            await expectOrpcCode(call(inviteRoutes.list, { sandboxId: `s1` }, asCaller(email, prisma)), `NOT_FOUND`);
            await expectOrpcCode(
                call(inviteRoutes.create, { sandboxId: `s1`, email: `new@example.com`, role: `viewer` }, asCaller(email, prisma)),
                `NOT_FOUND`,
            );
            await expectOrpcCode(call(inviteRoutes.revoke, { sandboxId: `s1`, email: `dev@example.com` }, asCaller(email, prisma)), `NOT_FOUND`);
        }
        expect(upsert).not.toHaveBeenCalled();
    });

    it(`a sandbox that does not exist reads the same as one the caller may not manage`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) }, sandboxMember: { findUnique: jest.fn() } });
        await expectOrpcCode(call(inviteRoutes.list, { sandboxId: `nope` }, { context: context({ prisma }) }), `NOT_FOUND`);
    });

    it(`rights never sit on a Full access or guest row, as the daemon writes it`, async () => {
        const { prisma, update } = rosterOf([
            memberRow(lead, `maintainer`),
            memberRow(`keeper@example.com`, `collaborator`, { manages: [`people`] }),
        ]);

        await call(inviteRoutes.setRole, { sandboxId: `s1`, email: `keeper@example.com`, role: `guest` }, asCaller(lead, prisma));
        expect(update).toHaveBeenLastCalledWith({ where: { id: `m-keeper@example.com` }, data: { role: `guest`, manages: [] } });
    });
});
