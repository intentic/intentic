import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../context.js";
import { INGRESS_TEST_PUBLIC_KEY, testIngressConfig } from "../testing.js";
import { sandboxRoutes } from "./sandbox.routes.js";

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
const sandboxRow = {
    id: `s1`,
    name: `dev`,
    image: null,
    ownerId: `u1`,
    token: `tok`,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    tunnelId: sandboxIdFromToken(`tok`)!,
};

// Minimal prisma stub; each test supplies only the calls its route actually makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: {
            webOrigin: `https://app.test`,
            intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
            ingress: { ...testIngressConfig },
            secrets: { key: `` },
            email: { apiKey: ``, from: `` },
        },
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
    }) as OrpcContext;

afterEach(() => {
    vi.unstubAllGlobals();
});

const expectOrpcCode = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
};

describe(`sandbox routes`, () => {
    it(`rejects unauthenticated callers`, async () => {
        await expectOrpcCode(call(sandboxRoutes.list, undefined, { context: context({ user: null }) }), `UNAUTHORIZED`);
    });

    it(`404s owner-only routes for sandboxes the caller does not own`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(null) } });
        await expectOrpcCode(call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma }) }), `NOT_FOUND`);
        await expectOrpcCode(call(sandboxRoutes.update, { sandboxId: `s1`, name: `renamed` }, { context: context({ prisma }) }), `NOT_FOUND`);
        await expectOrpcCode(
            call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `https://sandbox.example.com` }, { context: context({ prisma }) }),
            `NOT_FOUND`,
        );
        await expectOrpcCode(call(sandboxRoutes.emailSetupLink, { sandboxId: `s1` }, { context: context({ prisma }) }), `NOT_FOUND`);
    });

    it(`attach records the owner-asserted URL and stamps lastSeenAt like an announce`, async () => {
        const daemonUrl = `https://sandbox.example.com`;
        const update = vi.fn().mockResolvedValue({ ...sandboxRow, daemonUrl, lastSeenAt: new Date(`2026-07-26T10:00:00.000Z`) });
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });

        const summary = await call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl }, { context: context({ prisma }) });
        expect(update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl, lastSeenAt: expect.any(Date) }, include: { hosted: true } });
        expect(summary).toMatchObject({ id: `s1`, daemonUrl, lastSeenAt: `2026-07-26T10:00:00.000Z` });
    });

    it(`attach rejects a URL the browser could never call: http, junk, or a trailing slash`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update: vi.fn() } });
        // Web app is HTTPS; an http:// daemon would be blocked as mixed content.
        await expectOrpcCode(
            call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `http://sandbox.example.com` }, { context: context({ prisma }) }),
            `BAD_REQUEST`,
        );
        await expectOrpcCode(call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `nonsense` }, { context: context({ prisma }) }), `BAD_REQUEST`);
        // Trailing slash is normalized, not rejected: daemon calls append an absolute path.
        const update = vi.fn().mockResolvedValue({ ...sandboxRow, daemonUrl: `https://sandbox.example.com` });
        const normalizing = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        await call(
            sandboxRoutes.attach,
            { sandboxId: `s1`, daemonUrl: `https://sandbox.example.com/` },
            { context: context({ prisma: normalizing }) },
        );
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { daemonUrl: `https://sandbox.example.com`, lastSeenAt: expect.any(Date) },
            include: { hosted: true },
        });
    });

    it(`update writes only the provided fields and returns the summary with the logo`, async () => {
        const logo = `data:image/webp;base64,AA==`;
        const update = vi.fn().mockResolvedValue({ ...sandboxRow, name: `renamed`, image: logo });
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });

        const summary = await call(sandboxRoutes.update, { sandboxId: `s1`, name: `renamed` }, { context: context({ prisma }) });
        expect(update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { name: `renamed` }, include: { hosted: true } });
        expect(summary).toMatchObject({ id: `s1`, name: `renamed`, image: logo, role: `owner` });

        await call(sandboxRoutes.update, { sandboxId: `s1`, image: logo }, { context: context({ prisma }) });
        expect(update).toHaveBeenLastCalledWith({ where: { id: `s1` }, data: { image: logo }, include: { hosted: true } });

        // `null` must reach the row as a write, or clearing a logo would be silently ignored like an absent field.
        await call(sandboxRoutes.update, { sandboxId: `s1`, image: null }, { context: context({ prisma }) });
        expect(update).toHaveBeenLastCalledWith({ where: { id: `s1` }, data: { image: null }, include: { hosted: true } });
    });

    it(`maps a rejected Cloudflare token to BAD_REQUEST on zones`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(``, { status: 403 })));
        await expectOrpcCode(call(sandboxRoutes.zones, { token: `bad-token` }, { context: context() }), `BAD_REQUEST`);
    });

    it(`leave drops only the caller's own grant, matched on the lowercased session email`, async () => {
        const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({ sandboxMember: { deleteMany } });

        const result = await call(
            sandboxRoutes.leave,
            { sandboxId: `s1` },
            { context: context({ prisma, user: { ...user, email: `Guest@Example.com` } }) },
        );

        expect(deleteMany).toHaveBeenCalledWith({ where: { sandboxId: `s1`, email: `guest@example.com` } });
        expect(result).toEqual({ ok: true });
    });

    // Only ever mails the caller: there's no recipient input to abuse, and the link carries no credential.
    it(`emailSetupLink mails the caller's own address a link that resumes this sandbox`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue({ ...sandboxRow, setupCode: `s3cr3t-code` }) } });
        const sent = vi.fn().mockResolvedValue(new Response(`{}`));
        vi.stubGlobal(`fetch`, (_url: string, init?: RequestInit) => sent(JSON.parse(String(init?.body))));
        const config = { ...context().config, email: { apiKey: `re_test`, from: `intentic <no-reply@intentic.dev>` } };

        const result = await call(sandboxRoutes.emailSetupLink, { sandboxId: `s1` }, { context: context({ prisma, config }) });

        expect(result).toEqual({ ok: true });
        const [mail] = sent.mock.calls[0] as [{ to: string; html: string }];
        expect(mail.to).toBe(`owner@example.com`);
        expect(mail.html).toContain(`https://app.test/setup?sandbox=s1`);
        // Secrets stay off the wire; a mail is stored and forwarded by parties we have no relationship with.
        expect(mail.html).not.toContain(`s3cr3t-code`);
        expect(mail.html).not.toContain(sandboxRow.token);
    });

    it(`emailSetupLink logs the link instead of sending when email is unconfigured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow) } });
        const warn = vi.fn();
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`must not send`);
        });

        await call(
            sandboxRoutes.emailSetupLink,
            { sandboxId: `s1` },
            { context: context({ prisma, logger: { warn } as unknown as OrpcContext[`logger`] }) },
        );

        expect(warn).toHaveBeenCalledWith(
            { to: `owner@example.com`, link: `https://app.test/setup?sandbox=s1` },
            expect.stringContaining(`unconfigured`),
        );
    });

    // Owner email is lowercased into the payload: the daemon binds that identity as owner.
    it(`setupCode signs the reachability grant into the payload, with no provider call`, async () => {
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        const mixedCase = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };
        // Reachability is signed in-process; a fetch here is the regression this stub catches.
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`the mint must call no provider — a grant is signed in-process`);
        });

        const minted = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma, user: mixedCase }) });

        expect(minted.hostname).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
        const stored = JSON.parse((update.mock.calls.at(-1)![0] as { data: { setupPayload: string } }).data.setupPayload) as Record<string, string>;
        // Verified against the public key naming this sandbox; `expect.any(String)` would also pass an empty payload.
        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, stored[`SANDBOX_GRANT`]!)?.sandboxId).toBe(sandboxIdFromToken(`tok`));
        expect(stored[`INGRESS_URL`]).toBe(`https://ingress.sbx.test`);
        expect(stored[`SANDBOX_HOSTNAME`]).toBe(minted.hostname);
        expect(stored[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        // Nothing about reachability is written to the row; the payload is the whole handoff.
        expect(Object.keys((update.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data)).not.toContain(`tunnelId`);
    });

    it(`setupCode 404s when this platform has no reachability fabric configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update: vi.fn() } });
        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        await expectOrpcCode(call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: noFabric }), `NOT_FOUND`);
    });

    // Wizard needs this before drawing lanes, not after a mint 404s; same switch as setupCode.
    it(`addressOffer reports the fabric the mint requires, without minting`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn(), update: vi.fn() } });
        expect(await call(sandboxRoutes.addressOffer, {}, { context: context({ prisma }) })).toEqual({ enabled: true });

        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        expect(await call(sandboxRoutes.addressOffer, {}, { context: noFabric })).toEqual({ enabled: false });
    });

    it(`delete drops the row and calls nothing: the row's absence IS the revocation`, async () => {
        const deleteRow = vi.fn().mockResolvedValue({});
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`delete must call no provider — revocation is the row going away`);
        });
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), delete: deleteRow },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null) },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma }) });
        expect(deleteRow).toHaveBeenCalledExactlyOnceWith({ where: { id: `s1` } });
    });

    it(`creates a second sandbox for an owner who already has one: there is no cap`, async () => {
        const create = vi.fn().mockResolvedValue({ ...sandboxRow, id: `s2` });
        const prisma = fakePrisma({ sandbox: { create } });
        const summary = await call(sandboxRoutes.create, { name: `second` }, { context: context({ prisma }) });
        expect(summary).toMatchObject({ id: `s2`, role: `owner` });
    });

    // tunnelId is the key ingress registration and the DNS sweep look sandboxes up by; pinned against the shared
    // derivation, not a transcribed digest.
    it(`create stores the sandbox's derived tunnel id alongside the token's digest`, async () => {
        const create = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { create } });
        await call(sandboxRoutes.create, { name: `first` }, { context: context({ prisma }) });

        const { data } = create.mock.calls[0]![0] as { data: { token: string; tokenDigest: string; tunnelId: string } };
        // secrets.key is empty, so the stored token is the plaintext connect token.
        expect(data.tunnelId).toBe(sandboxIdFromToken(data.token));
        // Confirms tokenDigest's leading label is the tunnelId, which is what makes hostnames derivable from it.
        expect(data.tokenDigest.startsWith(data.tunnelId)).toBe(true);
    });

    it(`flags providedAddress only for a daemonUrl under the fabric's own zone`, async () => {
        const rows = [
            { ...sandboxRow, id: `s1`, daemonUrl: `https://sandbox-abc.sbx.test` },
            { ...sandboxRow, id: `s2`, daemonUrl: `https://sandbox-def.example.com` },
            { ...sandboxRow, id: `s3` },
        ];
        const config = {
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapDryRun: true },
            ingress: { ...testIngressConfig },
            secrets: { key: `` },
        } as OrpcContext[`config`];
        const prisma = fakePrisma({
            sandbox: { findMany: vi.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: vi.fn().mockResolvedValue([]) },
        });

        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma, config }) });
        expect(sandboxes.map((sandbox) => sandbox.providedAddress)).toEqual([true, false, false]);

        // Zone defaults even with the fabric off (no signing key); it must not flag on its own.
        const tokenless = {
            intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: true },
            ingress: { ...testIngressConfig, signingKey: `` },
            secrets: { key: `` },
        } as OrpcContext[`config`];
        const prismaAgain = fakePrisma({
            sandbox: { findMany: vi.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: vi.fn().mockResolvedValue([]) },
        });
        const { sandboxes: unflagged } = await call(sandboxRoutes.list, undefined, { context: context({ prisma: prismaAgain, config: tokenless }) });
        expect(unflagged.every((sandbox) => !sandbox.providedAddress)).toBe(true);
    });
});

// PAYMENT_REQUIRED is the platform's own code; oRPC's unknown-code fallback would otherwise report 500 for this
// ordinary refusal. Pinned here, not only in the Docker-gated e2e tier, since this must hold on a plain `pnpm test`.
describe(`a metered owner whose month is spent`, () => {
    const hostedConfig = {
        webOrigin: `https://app.test`,
        intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
        ingress: { ...testIngressConfig },
        secrets: { key: `` },
        email: { apiKey: ``, from: `` },
        hosted: { flyApiToken: `fly`, flyOrg: `org`, monthlyHours: 40, perUser: 1 },
        hostedPlan: { compEmails: `` },
    } as unknown as OrpcContext[`config`];

    // Owner's month fully spent, no plan, no machine awake: `findUnique` null keeps the idempotence check clear,
    // `count` zero passes the slot gate, and the hour ceiling is what actually refuses.
    const spent = () =>
        fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue({ ...sandboxRow, hosted: { id: `h1`, appName: `app`, machineId: `m1`, wokeAt: null } }) },
            hostedPlan: { findUnique: vi.fn().mockResolvedValue(null) },
            hostedUsage: { findUnique: vi.fn().mockResolvedValue({ minutes: 40 * 60 }) },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
        });

    it(`is refused the wake with PAYMENT_REQUIRED, carrying HTTP 402`, async () => {
        const error = await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: context({ prisma: spent(), config: hostedConfig }) }).then(
            () => undefined,
            (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(ORPCError);
        expect(error).toMatchObject({ code: `PAYMENT_REQUIRED`, status: 402 });
    });

    it(`is refused a new hosted machine the same way`, async () => {
        const error = await call(sandboxRoutes.hostedProvision, { sandboxId: `s1` }, { context: context({ prisma: spent(), config: hostedConfig }) }).then(
            () => undefined,
            (thrown: unknown) => thrown,
        );
        expect(error).toMatchObject({ code: `PAYMENT_REQUIRED`, status: 402 });
    });
});

/* THE CONNECT TOKEN STAYS WITH THE OWNER. sandbox.list hands the browser one row per sandbox the caller can
 * reach, and every row used to carry the decrypted connect token: a `viewer` invite was therefore worth the
 * owner's whole platform-side standing (the trial allowance, wallet signatures, the announce). A member's row
 * now says null; the daemon a member reaches is bound already and never asks for the token. */
describe(`sandbox.list and the connect token`, () => {
    it(`decrypts the token onto the owner's rows and withholds it from a member's`, async () => {
        const prisma = fakePrisma({
            sandbox: { findMany: vi.fn().mockResolvedValue([{ ...sandboxRow, hosted: null }]) },
            sandboxMember: {
                findMany: vi.fn().mockResolvedValue([{ role: `viewer`, sandbox: { ...sandboxRow, id: `s2`, ownerId: `u2`, token: `theirs`, hosted: null } }]),
            },
        });
        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma }) });
        expect(sandboxes.map(({ id, role, token }) => ({ id, role, token }))).toEqual([
            { id: `s1`, role: `owner`, token: `tok` },
            { id: `s2`, role: `viewer`, token: null },
        ]);
    });
});

/* DELETING A HOSTED SANDBOX CHARGES ITS OPEN STRETCH FIRST. The meter reads an awake machine's minutes live off
 * its row (hosted-usage.ts), so the cascade that took the row took the minutes with it, and
 * provision → work → delete → provision again was a free lane with no ceiling at all. */
describe(`sandbox.delete on a hosted sandbox`, () => {
    const hostedConfig = {
        webOrigin: `https://app.test`,
        intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
        ingress: { ...testIngressConfig },
        secrets: { key: `` },
        email: { apiKey: ``, from: `` },
        hosted: { flyApiToken: `fly`, flyOrg: `org`, monthlyHours: 40, perUser: 1 },
    } as OrpcContext[`config`];

    it(`charges the owner's month for the open stretch before the row goes`, async () => {
        const wokeAt = new Date(Date.now() - 90 * 60_000);
        const month = wokeAt.toISOString().slice(0, 7);
        const upsert = vi.fn().mockResolvedValue({});
        const deleteRow = vi.fn().mockResolvedValue({});
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(``, { status: 202 })));
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), delete: deleteRow },
            hostedMachine: {
                findUnique: vi.fn().mockResolvedValue({ id: `h1`, appName: `intentic-sbx-a`, machineId: `m1`, wokeAt }),
                update: vi.fn().mockResolvedValue({}),
            },
            hostedUsage: { upsert },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma, config: hostedConfig }) });
        expect(upsert).toHaveBeenCalledWith({
            where: { userId_month: { userId: `u1`, month } },
            create: { userId: `u1`, month, minutes: 90 },
            update: { minutes: { increment: 90 } },
        });
        // Charged BEFORE the cascade: after it there is no row left to hold the minutes.
        expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(deleteRow.mock.invocationCallOrder[0]!);
    });
});
