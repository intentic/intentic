import type { HostReport } from "@intentic/api-contract";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { call, ORPCError } from "@orpc/server";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { OrpcContext } from "../context.js";
import { INGRESS_TEST_PUBLIC_KEY, testIngressConfig } from "../testing.js";
import { RECOVERY_WINDOW_MS } from "../durations.js";
import { FIX_CODE_TTL_MS } from "./host-report.js";
import { sandboxRoutes } from "./sandbox.routes.js";
import { verifyAdoptionTicket } from "./recovery.js";

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
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    tunnelId: sandboxIdFromToken(`tok`)!,
};

// Minimal prisma stub; each test supplies only the calls its route actually makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => {
    const prisma = {
        ...overrides,
        $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma)),
        $queryRaw: jest.fn().mockResolvedValue([]),
        sandbox: {
            findUnique: jest.fn().mockResolvedValue({ tokenDigest: sha256Hex(`tok`) }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ...sandboxRow, hosted: null }),
            update: jest.fn().mockResolvedValue({}),
            ...overrides[`sandbox`],
        },
        hostedCleanup: { upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        sandboxTrash: { create: jest.fn().mockResolvedValue({}), ...overrides[`sandboxTrash`] },
    };
    return prisma as unknown as OrpcContext[`prisma`];
};

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: {
            webOrigin: `https://app.test`,
            intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
            ingress: { ...testIngressConfig },
            secrets: { key: `` },
            email: { apiKey: ``, from: `` },
            hosted: { flyApiToken: `` },
        },
        user,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        // No proxy in front: the same-source address cap has nothing to read and skips itself.
        headers: new Headers(),
        ...overrides,
    }) as OrpcContext;

afterEach(() => {
    unstubAllGlobals();
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
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(null) } });
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
        const update = jest.fn().mockResolvedValue({ ...sandboxRow, daemonUrl, lastSeenAt: new Date(`2026-07-26T10:00:00.000Z`) });
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update } });

        const summary = await call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl }, { context: context({ prisma }) });
        expect(update).toHaveBeenCalledWith({
            // The tombstone clears here too: a daemon the browser just reached is not a deleted one.
            where: { id: `s1` },
            data: { daemonUrl, lastSeenAt: expect.any(Date), removedAt: null, removedBy: null },
            include: { hosted: true },
        });
        expect(summary).toMatchObject({ id: `s1`, daemonUrl, lastSeenAt: `2026-07-26T10:00:00.000Z` });
    });

    it(`attach rejects a URL the browser could never call: http, junk, or a trailing slash`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update: jest.fn() } });
        // Web app is HTTPS; an http:// daemon would be blocked as mixed content.
        await expectOrpcCode(
            call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `http://sandbox.example.com` }, { context: context({ prisma }) }),
            `BAD_REQUEST`,
        );
        await expectOrpcCode(call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `nonsense` }, { context: context({ prisma }) }), `BAD_REQUEST`);
        // Trailing slash is normalized, not rejected: daemon calls append an absolute path.
        const update = jest.fn().mockResolvedValue({ ...sandboxRow, daemonUrl: `https://sandbox.example.com` });
        const normalizing = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update } });
        await call(
            sandboxRoutes.attach,
            { sandboxId: `s1`, daemonUrl: `https://sandbox.example.com/` },
            { context: context({ prisma: normalizing }) },
        );
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { daemonUrl: `https://sandbox.example.com`, lastSeenAt: expect.any(Date), removedAt: null, removedBy: null },
            include: { hosted: true },
        });
    });

    it(`update writes only the provided fields and returns the summary with the logo`, async () => {
        const logo = `data:image/webp;base64,AA==`;
        const update = jest.fn().mockResolvedValue({ ...sandboxRow, name: `renamed`, image: logo });
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update } });

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
        stubGlobal(`fetch`, () => Promise.resolve(new Response(``, { status: 403 })));
        await expectOrpcCode(call(sandboxRoutes.zones, { token: `bad-token` }, { context: context() }), `BAD_REQUEST`);
    });

    it(`leave drops only the caller's own grant, matched on the lowercased session email`, async () => {
        const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
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
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue({ ...sandboxRow, setupCode: `s3cr3t-code` }) } });
        const sent = jest.fn().mockResolvedValue(new Response(`{}`));
        stubGlobal(`fetch`, (_url: string, init?: RequestInit) => sent(JSON.parse(String(init?.body))));
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
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow) } });
        const warn = jest.fn();
        stubGlobal(`fetch`, () => {
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
        const update = jest.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update } });
        const mixedCase = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };
        // Reachability is signed in-process; a fetch here is the regression this stub catches.
        stubGlobal(`fetch`, () => {
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

    // The wizard mints on every mount, so this is what a reload does. Rotating here would orphan an install already
    // running: /setup/claim and /setup/report both find the sandbox BY its code, and the claim stamp is the only
    // evidence the wizard has that the command was ever pasted.
    it(`setupCode hands back the live code rather than rotating it, so a reload keeps the claim stamp`, async () => {
        const first = jest.fn().mockResolvedValue(sandboxRow);
        const firstPrisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update: first } });
        const minted = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma: firstPrisma }) });

        // The row as it stands after that mint, with a machine's claim already stamped on it.
        const claimed = {
            ...sandboxRow,
            setupCode: minted.code,
            setupCodeExpiresAt: new Date(minted.expiresAt),
            setupCodeClaimedAt: new Date(),
            setupPayload: (first.mock.calls.at(-1)![0] as { data: { setupPayload: string } }).data.setupPayload,
        };
        const update = jest.fn().mockResolvedValue(claimed);
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(claimed), update } });

        const again = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma }) });

        expect(again.code).toBe(minted.code);
        expect(again.expiresAt).toBe(minted.expiresAt);
        // No write at all is the claim stamp surviving; asserting on the code alone would pass a rewrite of the row.
        expect(update).not.toHaveBeenCalled();
    });

    // The other half: a code that no longer buys what the caller is asking for has to be replaced.
    it(`setupCode mints afresh once the code it holds has expired`, async () => {
        const stale = jest.fn().mockResolvedValue(sandboxRow);
        const stalePrisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update: stale } });
        const minted = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma: stalePrisma }) });

        const expired = {
            ...sandboxRow,
            setupCode: minted.code,
            setupCodeExpiresAt: new Date(Date.now() - 1000),
            setupPayload: (stale.mock.calls.at(-1)![0] as { data: { setupPayload: string } }).data.setupPayload,
        };
        const update = jest.fn().mockResolvedValue(expired);
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(expired), update } });

        const again = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma }) });

        expect(again.code).not.toBe(minted.code);
        expect((update.mock.calls.at(-1)![0] as { data: { setupCodeClaimedAt: Date | null } }).data.setupCodeClaimedAt).toBeNull();
    });

    it(`setupCode 404s when this platform has no reachability fabric configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), update: jest.fn() } });
        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        await expectOrpcCode(call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: noFabric }), `NOT_FOUND`);
    });

    // Wizard needs this before drawing lanes, not after a mint 404s; same switch as setupCode.
    it(`addressOffer reports the fabric the mint requires, without minting`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: jest.fn(), update: jest.fn() } });
        expect(await call(sandboxRoutes.addressOffer, {}, { context: context({ prisma }) })).toEqual({ enabled: true });

        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        expect(await call(sandboxRoutes.addressOffer, {}, { context: noFabric })).toEqual({ enabled: false });
    });

    it(`delete drops the row and calls nothing: the row's absence IS the revocation`, async () => {
        const deleteRow = jest.fn().mockResolvedValue({});
        const trash = jest.fn().mockResolvedValue({});
        stubGlobal(`fetch`, () => {
            throw new Error(`delete must call no provider — revocation is the row going away`);
        });
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(sandboxRow), delete: deleteRow },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(null) },
            sandboxTrash: { create: trash },
        });
        const before = Date.now();
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma }) });
        const after = Date.now();
        expect(deleteRow).toHaveBeenCalledTimes(1);
        expect(deleteRow).toHaveBeenCalledWith({ where: { id: `s1` } });
        // The identity goes at once; what the owner can still ask for back is this row, and only until it expires.
        expect(trash).toHaveBeenCalledTimes(1);
        const { data } = trash.mock.calls[0]![0] as { data: { name: string; ownerId: string; appName?: string; purgeAfter: Date } };
        expect(data).toMatchObject({ name: sandboxRow.name, ownerId: sandboxRow.ownerId });
        // Nothing to hold on the provider's side for a sandbox that ran on the owner's own computer.
        expect(data.appName).toBeUndefined();
        expect(data.purgeAfter.getTime()).toBeGreaterThanOrEqual(before + RECOVERY_WINDOW_MS);
        expect(data.purgeAfter.getTime()).toBeLessThanOrEqual(after + RECOVERY_WINDOW_MS);
    });

    it(`creates a second sandbox for an owner who already has one: there is no cap`, async () => {
        const create = jest.fn().mockResolvedValue({ ...sandboxRow, id: `s2` });
        const prisma = fakePrisma({ sandbox: { create } });
        const summary = await call(sandboxRoutes.create, { name: `second` }, { context: context({ prisma }) });
        expect(summary).toMatchObject({ id: `s2`, role: `owner` });
    });

    // tunnelId is the key ingress registration and the DNS sweep look sandboxes up by; pinned against the shared
    // derivation, not a transcribed digest.
    it(`create stores the sandbox's derived tunnel id alongside the token's digest`, async () => {
        const create = jest.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { create } });
        await call(sandboxRoutes.create, { name: `first` }, { context: context({ prisma }) });

        const { data } = create.mock.calls[0]![0] as { data: { token: string; tokenDigest: string; tunnelId: string } };
        // secrets.key is empty, so the stored token is the plaintext connect token.
        expect(sandboxIdFromToken(data.token)).toBe(data.tunnelId);
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
            sandbox: { findMany: jest.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: jest.fn().mockResolvedValue([]) },
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
            sandbox: { findMany: jest.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: jest.fn().mockResolvedValue([]) },
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
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `org`,
            monthlyHours: 40,
            perUser: 1,
            newAccountDays: 0,
            newAccountHours: 0,
            provisionsPerIpPerDay: 0,
            provisionsPerDomainPerDay: 0,
        },
        hostedPlan: { compEmails: ``, stripeSecretKey: ``, stripePrices: `` },
        api: { trustedIpHeader: `` },
    } as unknown as OrpcContext[`config`];

    // Owner's month fully spent, no plan, no machine awake: `findUnique` null keeps the idempotence check clear,
    // `count` zero passes the slot gate, and the hour ceiling is what actually refuses.
    const spent = () =>
        fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    ...sandboxRow,
                    hosted: { id: `h1`, appName: `app`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
            },
            user: { findUnique: jest.fn().mockResolvedValue({ hostedSuspendedAt: null, hostedSuspendedReason: null }) },
            hostedPlan: { findUnique: jest.fn().mockResolvedValue(null) },
            // The account's free hours, all forty spent this month on its one free machine.
            hostedUsage: { groupBy: jest.fn().mockResolvedValue([{ sandboxId: `s1`, tier: `free`, _sum: { minutes: 40 * 60 } }]) },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                count: jest.fn().mockResolvedValue(0),
            },
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
        const error = await call(
            sandboxRoutes.hostedProvision,
            { sandboxId: `s1`, token: `tok` },
            { context: context({ prisma: spent(), config: hostedConfig }) },
        ).then(
            () => undefined,
            (thrown: unknown) => thrown,
        );
        expect(error).toMatchObject({ code: `PAYMENT_REQUIRED`, status: 402 });
    });
});

/* A SUSPENDED OWNER'S MACHINE STARTS FOR NOBODY: not for the owner, not for a member who could wake it, and not by
 * being released and provisioned again. FORBIDDEN in the suspension's own words, before the meter is read. */
describe(`an owner whose hosted lane is suspended`, () => {
    const hostedConfig = {
        webOrigin: `https://app.test`,
        intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
        ingress: { ...testIngressConfig },
        secrets: { key: `` },
        email: { apiKey: ``, from: `` },
        hosted: {
            flyApiToken: `fly`,
            flyOrg: `org`,
            monthlyHours: 40,
            perUser: 1,
            newAccountDays: 0,
            newAccountHours: 0,
            provisionsPerIpPerDay: 0,
            provisionsPerDomainPerDay: 0,
        },
        hostedPlan: { compEmails: ``, stripeSecretKey: ``, stripePrices: `` },
        api: { trustedIpHeader: `` },
    } as unknown as OrpcContext[`config`];

    const suspended = () => {
        const usage = jest.fn().mockResolvedValue([]);
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue({
                    ...sandboxRow,
                    hosted: { id: `h1`, appName: `app`, machineId: `m1`, wokeAt: null, tier: `free` },
                }),
            },
            user: { findUnique: jest.fn().mockResolvedValue({ hostedSuspendedAt: new Date(), hostedSuspendedReason: `mining` }) },
            hostedPlan: { findUnique: jest.fn().mockResolvedValue(null) },
            hostedUsage: { groupBy: usage },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                count: jest.fn().mockResolvedValue(0),
            },
        });
        return { prisma, usage };
    };

    it(`is refused the wake with FORBIDDEN naming the reason, and the meter is never read`, async () => {
        const { prisma, usage } = suspended();
        const error = await call(sandboxRoutes.wake, { sandboxId: `s1` }, { context: context({ prisma, config: hostedConfig }) }).then(
            () => undefined,
            (thrown: unknown) => thrown,
        );
        expect(error).toMatchObject({ code: `FORBIDDEN` });
        expect((error as Error).message).toContain(`mining`);
        expect(usage).not.toHaveBeenCalled();
    });

    it(`is refused a new hosted machine the same way`, async () => {
        const { prisma } = suspended();
        await expectOrpcCode(
            call(sandboxRoutes.hostedProvision, { sandboxId: `s1`, token: `tok` }, { context: context({ prisma, config: hostedConfig }) }),
            `FORBIDDEN`,
        );
    });

    it(`is offered nothing, and told why`, async () => {
        const { prisma } = suspended();
        const offer = await call(sandboxRoutes.hostedOffer, undefined, {
            context: context({ prisma, config: hostedConfig, headers: new Headers() }),
        });
        expect(offer).toMatchObject({ enabled: true, remaining: 0, suspended: true });
    });
});

/* THE CONNECT TOKEN STAYS WITH THE OWNER. */
describe(`sandbox.list and the connect token`, () => {
    it(`decrypts the token onto the owner's rows and withholds it from a member's`, async () => {
        const prisma = fakePrisma({
            sandbox: { findMany: jest.fn().mockResolvedValue([{ ...sandboxRow, hosted: null }]) },
            sandboxMember: {
                findMany: jest.fn().mockResolvedValue([
                    { role: `viewer`, sandbox: { ...sandboxRow, id: `s2`, ownerId: `u2`, token: `theirs`, hosted: null } },
                ]),
            },
        });
        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma }) });
        expect(sandboxes.map(({ id, role, token }) => ({ id, role, token }))).toEqual([
            { id: `s1`, role: `owner`, token: `tok` },
            { id: `s2`, role: `viewer`, token: null },
        ]);
    });
});

/* DELETING A HOSTED SANDBOX CHARGES ITS OPEN STRETCH FIRST. */
describe(`sandbox.delete on a hosted sandbox`, () => {
    const hostedConfig = {
        webOrigin: `https://app.test`,
        intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true },
        ingress: { ...testIngressConfig },
        secrets: { key: `` },
        email: { apiKey: ``, from: `` },
        hosted: { flyApiToken: `fly`, flyOrg: `org`, monthlyHours: 40, perUser: 1 },
    } as OrpcContext[`config`];

    // A hosted machine as the trash has to record it: everything a restore needs to land on the same disk.
    const hostedMachineRow = {
        id: `h1`,
        sandboxId: `s1`,
        appName: `intentic-sbx-a`,
        machineId: `m1`,
        volumeId: `vol1`,
        region: `iad`,
        image: `registry/overlay:1`,
        baseImage: `registry/base:1`,
        baseDigest: `sha256:${`1`.repeat(64)}`,
        environmentHash: `abc123`,
        tier: `free`,
        cpuKind: `shared`,
        cpus: 4,
        memoryMb: 4096,
        volumeGb: 10,
    };

    it(`charges the owner's month for the open stretch before the row goes`, async () => {
        const wokeAt = new Date(Date.now() - 90 * 60_000);
        const month = wokeAt.toISOString().slice(0, 7);
        const upsert = jest.fn().mockResolvedValue({});
        const deleteRow = jest.fn().mockResolvedValue({});
        stubGlobal(`fetch`, () => Promise.resolve(new Response(``, { status: 202 })));
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue(sandboxRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...sandboxRow, hosted: { ...hostedMachineRow, wokeAt } }),
                delete: deleteRow,
            },
            hostedMachine: {
                findUnique: jest.fn().mockResolvedValue({ ...hostedMachineRow, wokeAt }),
                update: jest.fn().mockResolvedValue({}),
                delete: jest.fn().mockResolvedValue({}),
            },
            hostedUsage: { upsert },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma, config: hostedConfig }) });
        // A free machine's minutes are the account's free hours, and stay on the account once the sandbox is gone.
        expect(upsert).toHaveBeenCalledWith({
            where: { sandboxId_month_tier: { sandboxId: `s1`, month, tier: `free` } },
            create: { sandboxId: `s1`, ownerId: `u1`, month, tier: `free`, minutes: 90 },
            update: { minutes: { increment: 90 } },
        });
        // Charged BEFORE the cascade: after it there is no row left to hold the minutes.
        expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(deleteRow.mock.invocationCallOrder[0]!);
    });

    // Trash racing a wake (specs/HostedStretch.tla): the wake opened a newer stretch after the trash read the row.
    it(`charges the stretch the row holds at the delete, and stops the machine only once the row is gone`, async () => {
        const read = new Date(Date.now() - 90 * 60_000);
        const held = new Date(Date.now() - 10 * 60_000);
        const month = held.toISOString().slice(0, 7);
        const events: string[] = [];
        const upsert = jest.fn().mockResolvedValue({});
        stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
            events.push(`${init?.method ?? `GET`} ${url.split(`/`).pop()}`);
            return Promise.resolve(new Response(``, { status: 200 }));
        });
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue(sandboxRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...sandboxRow, hosted: { ...hostedMachineRow, wokeAt: read } }),
                delete: jest.fn(async () => {
                    events.push(`delete sandbox`);
                    return {};
                }),
            },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue({ ...hostedMachineRow, wokeAt: held }), delete: jest.fn().mockResolvedValue({}) },
            hostedUsage: { upsert },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma, config: hostedConfig }) });
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith({
            where: { sandboxId_month_tier: { sandboxId: `s1`, month, tier: `free` } },
            create: { sandboxId: `s1`, ownerId: `u1`, month, tier: `free`, minutes: 10 },
            update: { minutes: { increment: 10 } },
        });
        expect(events).toEqual([`delete sandbox`, `POST stop`]);
    });

    it(`stops a deleted sandbox's machine and keeps its app, so the disk is there to restore onto`, async () => {
        const calls: { method: string; url: string }[] = [];
        stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
            calls.push({ method: init?.method ?? `GET`, url });
            return Promise.resolve(new Response(``, { status: 200 }));
        });
        const trash = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: {
                findFirst: jest.fn().mockResolvedValue(sandboxRow),
                findUniqueOrThrow: jest.fn().mockResolvedValue({ ...sandboxRow, hosted: { ...hostedMachineRow, wokeAt: null } }),
                delete: jest.fn().mockResolvedValue({}),
            },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(hostedMachineRow), delete: jest.fn().mockResolvedValue({}) },
            sandboxTrash: { create: trash },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma, config: hostedConfig }) });
        // Stopped, so it bills nothing; NOT deleted, which on Fly takes the volume with the app.
        expect(calls.filter((entry) => entry.method === `DELETE`)).toHaveLength(0);
        expect(calls.some((entry) => entry.method === `POST` && entry.url.endsWith(`/machines/m1/stop`))).toBe(true);
        const { data } = trash.mock.calls[0]![0] as { data: Record<string, unknown> };
        // The app, machine, volume and overlay are what a restore needs; the sandbox's own `image` is its logo.
        expect(data).toMatchObject({
            appName: hostedMachineRow.appName,
            machineId: hostedMachineRow.machineId,
            volumeId: hostedMachineRow.volumeId,
            region: hostedMachineRow.region,
            flyImage: hostedMachineRow.image,
            baseImage: hostedMachineRow.baseImage,
            baseDigest: hostedMachineRow.baseDigest,
            environmentHash: hostedMachineRow.environmentHash,
        });
    });
});

/* THE RECOVERY COMMAND'S FIX CODE: the owner's, for a sandbox on a machine of their own that is still there. */
describe(`sandbox.fixCode`, () => {
    const minting = (row: object = sandboxRow, hosted: { id: string } | null = null) => {
        const update = jest.fn().mockResolvedValue({});
        const prisma = fakePrisma({
            sandbox: { findFirst: jest.fn().mockResolvedValue(row), update },
            hostedMachine: { findUnique: jest.fn().mockResolvedValue(hosted) },
        });
        return { prisma, update };
    };

    it(`mints a code valid for thirty minutes onto the owner's row`, async () => {
        const { prisma, update } = minting();
        const before = Date.now();
        const minted = await call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma }) });
        const after = Date.now();

        // The setup code's generator: eleven base62 characters, safe as a shell argument.
        expect(minted.code).toMatch(/^[0-9A-Za-z]{11}$/);
        expect(Date.parse(minted.expiresAt)).toBeGreaterThanOrEqual(before + FIX_CODE_TTL_MS);
        expect(Date.parse(minted.expiresAt)).toBeLessThanOrEqual(after + FIX_CODE_TTL_MS);
        expect(FIX_CODE_TTL_MS).toBe(30 * 60 * 1000);
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { fixCode: minted.code, fixCodeExpiresAt: new Date(minted.expiresAt) } });
    });

    it(`replaces the code on every mint`, async () => {
        const { prisma, update } = minting();
        const first = await call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma }) });
        const second = await call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma }) });
        expect(second.code).not.toBe(first.code);
        expect(update).toHaveBeenLastCalledWith({ where: { id: `s1` }, data: { fixCode: second.code, fixCodeExpiresAt: new Date(second.expiresAt) } });
    });

    // A member finds no row through the owner-only gate, the same NOT_FOUND every owner-only route answers.
    it(`is NOT_FOUND to a member, and writes nothing`, async () => {
        const findFirst = jest.fn().mockResolvedValue(null);
        const update = jest.fn();
        const prisma = fakePrisma({ sandbox: { findFirst, update } });
        await expectOrpcCode(call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma, user: { ...user, id: `u2` } }) }), `NOT_FOUND`);
        expect(findFirst).toHaveBeenCalledWith({ where: { id: `s1`, ownerId: `u2` } });
        expect(update).not.toHaveBeenCalled();
    });

    it(`is NOT_FOUND for a hosted sandbox, and writes nothing`, async () => {
        const { prisma, update } = minting(sandboxRow, { id: `h1` });
        await expectOrpcCode(call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma }) }), `NOT_FOUND`);
        expect(update).not.toHaveBeenCalled();
    });

    it(`is NOT_FOUND for a sandbox whose container was removed, and writes nothing`, async () => {
        const { prisma, update } = minting({ ...sandboxRow, removedAt: new Date(), removedBy: `rog` });
        await expectOrpcCode(call(sandboxRoutes.fixCode, { sandboxId: `s1` }, { context: context({ prisma }) }), `NOT_FOUND`);
        expect(update).not.toHaveBeenCalled();
    });
});

/* WHAT THE MACHINE LAST REPORTED STAYS WITH THE OWNER, and only for a sandbox on a machine of its own. */
describe(`sandbox.list and the host report`, () => {
    const report: HostReport = {
        source: `agent`,
        machine: `rog`,
        os: `windows`,
        stage: `done`,
        outcome: `needs-you`,
        checks: [{ id: `disk`, label: `Disk space`, state: `fail`, problem: `C: has 200 MB free.`, remedy: `Free 10 GB on C:.`, fix: `you` }],
        at: `2026-09-30T12:00:00.000Z`,
    };

    const listed = async (owned: object[], shared: object[] = []) => {
        const prisma = fakePrisma({
            sandbox: { findMany: jest.fn().mockResolvedValue(owned) },
            sandboxMember: { findMany: jest.fn().mockResolvedValue(shared) },
        });
        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma }) });
        return sandboxes.map(({ id, role, hostReport }) => ({ id, role, hostReport }));
    };

    it(`shows the report on the owner's row and null on a member's`, async () => {
        expect(
            await listed([{ ...sandboxRow, hostReport: report, hosted: null }], [{ role: `writer`, sandbox: { ...sandboxRow, id: `s2`, ownerId: `u2`, hostReport: report, hosted: null } }]),
        ).toEqual([
            { id: `s1`, role: `owner`, hostReport: report },
            { id: `s2`, role: `writer`, hostReport: null },
        ]);
    });

    it(`answers null for a row with none, one that no longer parses, and a hosted sandbox`, async () => {
        const hosted = { region: `iad`, warm: false, previousImage: null };
        expect(
            await listed([
                { ...sandboxRow, id: `s1`, hostReport: null, hosted: null },
                { ...sandboxRow, id: `s2`, hostReport: { stage: `done` }, hosted: null },
                { ...sandboxRow, id: `s3`, hostReport: report, hosted },
            ]),
        ).toEqual([
            { id: `s1`, role: `owner`, hostReport: null },
            { id: `s2`, role: `owner`, hostReport: null },
            { id: `s3`, role: `owner`, hostReport: null },
        ]);
    });
});

// The recovery screen's two questions of the registry (recovery.ts): what it holds of ids the editor remembers, and a
// ticket to adopt one it holds nothing of. A ticket is never minted for an id it holds (anyone's) or deleted.
describe(`recovery`, () => {
    const SANDBOX = `0123456789ab`;
    const registry = (rows: { id: string; tunnelId: string; ownerId: string }[], tombstones: string[]) =>
        fakePrisma({
            sandbox: { findMany: jest.fn().mockResolvedValue(rows) },
            sandboxTombstone: { findMany: jest.fn().mockResolvedValue(tombstones.map((tunnelId) => ({ tunnelId }))) },
        });
    // The refusal a call ended in, by code and the sentence the screen shows.
    const refusalOf = async (promise: Promise<unknown>) => {
        const thrown = await promise.then(
            () => undefined,
            (error: Error) => error,
        );
        if (!(thrown instanceof ORPCError)) {
            throw new Error(`expected an ORPCError, got ${String(thrown)}`);
        }
        return { code: thrown.code, message: thrown.message };
    };

    it(`looks remembered ids up for the signed-in account`, async () => {
        const prisma = registry([{ id: `s1`, tunnelId: SANDBOX, ownerId: `u1` }], [`cccccccccccc`]);
        expect(await call(sandboxRoutes.lookup, { sandboxIds: [SANDBOX, `bbbbbbbbbbbb`, `cccccccccccc`] }, { context: context({ prisma }) })).toEqual({
            sandboxes: [
                { sandboxId: SANDBOX, standing: `yours`, id: `s1` },
                { sandboxId: `bbbbbbbbbbbb`, standing: `unknown` },
                { sandboxId: `cccccccccccc`, standing: `deleted` },
            ],
        });
    });

    it(`tickets an id the registry has no record of, for the signed-in account`, async () => {
        const answer = await call(sandboxRoutes.adoptionTicket, { sandboxId: SANDBOX }, { context: context({ prisma: registry([], []) }) });
        expect(verifyAdoptionTicket(INGRESS_TEST_PUBLIC_KEY, answer.ticket, Date.now())).toEqual({
            sandboxId: SANDBOX,
            userId: `u1`,
            expiresAt: Math.floor(Date.parse(answer.expiresAt) / 1000) * 1000,
        });
    });

    it(`refuses a ticket for an id the registry holds or deleted`, async () => {
        const ask = (prisma: OrpcContext[`prisma`]) => refusalOf(call(sandboxRoutes.adoptionTicket, { sandboxId: SANDBOX }, { context: context({ prisma }) }));
        expect(await ask(registry([{ id: `s1`, tunnelId: SANDBOX, ownerId: `u1` }], []))).toEqual({ code: `CONFLICT`, message: `this sandbox is already in your list` });
        expect(await ask(registry([{ id: `s9`, tunnelId: SANDBOX, ownerId: `u2` }], []))).toEqual({
            code: `CONFLICT`,
            message: `this sandbox is registered to another account`,
        });
        expect(await ask(registry([], [SANDBOX]))).toEqual({
            code: `NOT_FOUND`,
            message: `this sandbox was deleted from intentic: restore it from the trash, or set up a new one`,
        });
    });

    it(`refuses on a platform that hands out no addresses, which has no grant to vouch with`, async () => {
        const addressless = context({ prisma: registry([], []) });
        const refused = await refusalOf(
            call(sandboxRoutes.adoptionTicket, { sandboxId: SANDBOX }, { context: { ...addressless, config: { ...addressless.config, ingress: { ...addressless.config.ingress, signingKey: `` } } } }),
        );
        expect(refused).toEqual({
            code: `PRECONDITION_FAILED`,
            message: `this platform hands out no addresses, so it cannot vouch for a sandbox: connect it by its address instead`,
        });
    });
});
