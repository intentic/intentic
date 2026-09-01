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

// Minimal prisma fake: each test overrides just the calls its route makes.
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

// A Cloudflare API where the tunnel delete fails with `tunnelDelete` (its connections cleanup + zone/list all

// A happy-path Cloudflare API: one zone, tunnel t1 found by name, connector token, ingress + DNS accepted.

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
        // The web app is HTTPS, so an http:// daemon would be blocked as mixed content on every call.
        await expectOrpcCode(
            call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `http://sandbox.example.com` }, { context: context({ prisma }) }),
            `BAD_REQUEST`,
        );
        await expectOrpcCode(call(sandboxRoutes.attach, { sandboxId: `s1`, daemonUrl: `nonsense` }, { context: context({ prisma }) }), `BAD_REQUEST`);
        // A trailing slash is normalized away rather than rejected: daemon calls append an absolute path.
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

        // `null` is a value, not an omission: it has to reach the row as a write, or removing a logo would be
        // silently ignored the same way an absent field is.
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

    /* The phone's handoff. Two properties are the whole point of the route and both are worth pinning: it can
     * only mail the CALLER (there is no recipient input to abuse), and what it mails is an address, not a
     * credential: the setup code and the connect token must never ride a channel we hand to a mail provider. */
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
        // The sandbox's own secrets stay off the wire: a mail is stored and forwarded by people we have no
        // relationship with, and the page behind this link is session-gated anyway.
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

    /* THE MINT: a signature and a payload carrying exactly what the box needs to dial the edge. Nothing is
     * cached, which is the change — the hub era wrote an account token to the row here, and the assertion
     * that used to guard that column is now the one below saying the ROUTE calls no provider at all. The owner
     * email is lowercased into the payload for the reason it always was: the daemon binds that one Google
     * identity as owner. */
    it(`setupCode signs the reachability grant into the payload, with no provider call`, async () => {
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        const mixedCase = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };
        // Provisioning reachability is local arithmetic now: a fetch from this route is the regression.
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`the mint must call no provider — a grant is signed in-process`);
        });

        const minted = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma, user: mixedCase }) });

        // The address is derived from the connect token, so it is knowable before anything runs.
        expect(minted.hostname).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
        const stored = JSON.parse((update.mock.calls.at(-1)![0] as { data: { setupPayload: string } }).data.setupPayload) as Record<string, string>;
        // The grant is the credential, so it is asserted the way the ingress will read it: verified against the
        // public key, naming THIS sandbox. A `expect.any(String)` here would pass for the empty payload too.
        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, stored[`SANDBOX_GRANT`]!)?.sandboxId).toBe(sandboxIdFromToken(`tok`));
        expect(stored[`INGRESS_URL`]).toBe(`https://ingress.sbx.test`);
        expect(stored[`SANDBOX_HOSTNAME`]).toBe(minted.hostname);
        expect(stored[`OWNER_EMAIL`]).toBe(`owner@example.com`);
        // Nothing about reachability is written to the row: the payload IS the whole handdown.
        expect(Object.keys((update.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data)).not.toContain(`tunnelId`);
    });

    it(`setupCode 404s when this platform has no reachability fabric configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update: vi.fn() } });
        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        await expectOrpcCode(call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: noFabric }), `NOT_FOUND`);
    });

    /* …AND THE SAME ANSWER, ASKED WITHOUT SPENDING A CODE. The wizard has to know which lanes it can offer
     * before it draws them; discovering it from the mint's 404 meant drawing the ones that need an address
     * first and taking them back a round-trip later. Same switch, so the two can never disagree. */
    it(`addressOffer reports the fabric the mint requires, without minting`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn(), update: vi.fn() } });
        expect(await call(sandboxRoutes.addressOffer, {}, { context: context({ prisma }) })).toEqual({ enabled: true });

        const noFabric = context({ prisma });
        (noFabric.config as { ingress: { signingKey: string } }).ingress.signingKey = ``;
        expect(await call(sandboxRoutes.addressOffer, {}, { context: noFabric })).toEqual({ enabled: false });
    });

    /* DELETING THE ROW IS THE REVOCATION, and this is the test that used to assert the opposite. Under the hub
     * a delete had to call upstream FIRST and the whole removal failed on a hub hiccup, because a grant whose
     * row was gone could never be found again. Now the edge asks US on every tunnel registration, so the row's
     * absence is the refusal: there is no call to make, and a removal cannot be blocked by anything but the
     * database. The `fetch` stub is the assertion — a provider call on this path is the regression. */
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

    /* THE 12-HEX ID IS WRITTEN AT CREATION, because it is the key two readers that cannot derive it look a
     * sandbox up by: the ingress on tunnel registration (GET /api/reachability/<id>) and the DNS sweep. Pinned
     * against the shared derivation rather than a transcribed digest, so a change to either side fails here. */
    it(`create stores the sandbox's derived tunnel id alongside the token's digest`, async () => {
        const create = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { create } });
        await call(sandboxRoutes.create, { name: `first` }, { context: context({ prisma }) });

        const { data } = create.mock.calls[0]![0] as { data: { token: string; tokenDigest: string; tunnelId: string } };
        // secrets.key is empty, so the stored token passes through as the plaintext connect token.
        expect(data.tunnelId).toBe(sandboxIdFromToken(data.token));
        // And it really is the digest's leading label, which is what makes every hostname derivable from it.
        expect(data.tokenDigest.startsWith(data.tunnelId)).toBe(true);
    });

    it(`flags providedTunnel only for a daemonUrl under the fabric's own zone`, async () => {
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
        expect(sandboxes.map((sandbox) => sandbox.providedTunnel)).toEqual([true, false, false]);

        // The zone alone defaults even when the fabric is off (no signing key): it must not flag on its own.
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
        expect(unflagged.every((sandbox) => !sandbox.providedTunnel)).toBe(true);
    });
});
