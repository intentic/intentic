import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { call, ORPCError } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../context.js";
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
    zrokToken: null,
};

// Minimal prisma fake: each test overrides just the calls its route makes.
const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: {
            webOrigin: `https://app.test`,
            intenticCloudflare: { apiToken: ``, zone: ``, reapDryRun: true }, zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
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
        // A trailing slash is normalized away rather than rejected — daemon calls append an absolute path.
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
     * credential — the setup code and the connect token must never ride a channel we hand to a mail provider. */
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
        // The sandbox's own secrets stay off the wire — a mail is stored and forwarded by people we have no
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

    /* THE MINT, on the self-hosted fabric: one account per sandbox, cached on the row, and a payload carrying
     * exactly what the box needs to enable and share. The owner email is lowercased into it for the reason it
     * always was — the daemon binds that one Google identity as owner. */
    it(`setupCode mints the reachability grant, caches it, and hands the box its whole payload`, async () => {
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        const mixedCase = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };
        vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
            if (String(url).endsWith(`/namespaces`)) {
                return Promise.resolve(new Response(JSON.stringify([{ namespaceToken: `ns-1`, name: `public` }])));
            }
            if ((init?.method ?? `GET`) === `POST` && String(url).endsWith(`/account`)) {
                return Promise.resolve(new Response(JSON.stringify({ accountToken: `acct-9` }), { status: 201 }));
            }
            throw new Error(`unexpected fetch: ${String(url)}`);
        });

        const minted = await call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: context({ prisma, user: mixedCase }) });

        // The address is derived from the connect token, so it is knowable before anything runs.
        expect(minted.hostname).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
        // The account token is cached on the row: a second mint reuses it rather than growing a second grant.
        const cached = update.mock.calls.find((entry) => (entry[0] as { data: Record<string, unknown> }).data[`zrokToken`] !== undefined);
        expect(cached).toBeDefined();
        const stored = JSON.parse((update.mock.calls.at(-1)![0] as { data: { setupPayload: string } }).data.setupPayload) as Record<string, string>;
        expect(stored[`ZROK_TOKEN`]).toBe(`acct-9`);
        expect(stored[`ZROK_NAMESPACE`]).toBe(`ns-1`);
        expect(stored[`ZROK_API`]).toBe(`https://zrok2.sbx.test`);
        expect(stored[`OWNER_EMAIL`]).toBe(`owner@example.com`);
    });

    it(`setupCode 404s when this platform has no tunnel fabric configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update: vi.fn() } });
        const noFabric = context({ prisma });
        (noFabric.config as { zrok: { adminToken: string } }).zrok.adminToken = ``;
        await expectOrpcCode(call(sandboxRoutes.setupCode, { sandboxId: `s1` }, { context: noFabric }), `NOT_FOUND`);
    });

    /* …AND THE SAME ANSWER, ASKED WITHOUT SPENDING A CODE. The wizard has to know which lanes it can offer
     * before it draws them; discovering it from the mint's 404 meant drawing the ones that need an address
     * first and taking them back a round-trip later. Same switch, so the two can never disagree. */
    it(`addressOffer reports the fabric the mint requires, without minting`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn(), update: vi.fn() } });
        expect(await call(sandboxRoutes.addressOffer, {}, { context: context({ prisma }) })).toEqual({ enabled: true });

        const noFabric = context({ prisma });
        (noFabric.config as { zrok: { adminToken: string } }).zrok.adminToken = ``;
        expect(await call(sandboxRoutes.addressOffer, {}, { context: noFabric })).toEqual({ enabled: false });
    });

    // The teardown a delete owes the hub: the account goes, taking every environment, share and name with it.
    it(`delete revokes the sandbox's reachability grant before dropping the row`, async () => {
        const order: string[] = [];
        const deleteRow = vi.fn().mockImplementation(() => {
            order.push(`row`);
            return Promise.resolve({});
        });
        vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
            order.push(`hub`);
            expect((init?.method ?? `GET`)).toBe(`DELETE`);
            expect(String(url)).toContain(`/account`);
            return Promise.resolve(new Response(``, { status: 200 }));
        });
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue({ ...sandboxRow, zrokToken: `enc-acct` }), delete: deleteRow },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null) },
        });
        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma }) });
        // Hub first: the hub cannot be asked what it holds (v2 lists no accounts), so a grant whose row is
        // already gone could never be found again.
        expect(order).toEqual([`hub`, `row`]);
    });

    // …and a hub that refuses keeps the row: the user retries a removal rather than losing the only record of
    // an address that is still live.
    it(`delete fails, leaving the row, when the hub cannot revoke`, async () => {
        const deleteRow = vi.fn();
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(`down`, { status: 503 })));
        const prisma = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue({ ...sandboxRow, zrokToken: `enc-acct` }), delete: deleteRow },
            hostedMachine: { findUnique: vi.fn().mockResolvedValue(null) },
        });
        await expectOrpcCode(call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma }) }), `BAD_GATEWAY`);
        expect(deleteRow).not.toHaveBeenCalled();
    });

    it(`creates a second sandbox for an owner who already has one — there is no cap`, async () => {
        const create = vi.fn().mockResolvedValue({ ...sandboxRow, id: `s2` });
        const prisma = fakePrisma({ sandbox: { create } });
        const summary = await call(sandboxRoutes.create, { name: `second` }, { context: context({ prisma }) });
        expect(summary).toMatchObject({ id: `s2`, role: `owner` });
    });

    it(`flags providedTunnel only for a daemonUrl under the fabric's own zone`, async () => {
        const rows = [
            { ...sandboxRow, id: `s1`, daemonUrl: `https://sandbox-abc.sbx.test` },
            { ...sandboxRow, id: `s2`, daemonUrl: `https://sandbox-def.example.com` },
            { ...sandboxRow, id: `s3` },
        ];
        const config = {
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapDryRun: true }, zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
            secrets: { key: `` },
        } as OrpcContext[`config`];
        const prisma = fakePrisma({
            sandbox: { findMany: vi.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: vi.fn().mockResolvedValue([]) },
        });

        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma, config }) });
        expect(sandboxes.map((sandbox) => sandbox.providedTunnel)).toEqual([true, false, false]);

        // The zone alone defaults even when the fabric is off (no admin token) — it must not flag on its own.
        const tokenless = {
            intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: true },
            zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: ``, zone: `sbx.test` },
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

describe(`cloud lane routes`, () => {
    // A row a cloudProvision can act on: live intentic-mode setup code (plaintext payload — secrets.key is
    // empty in the fake config, so encryptSecret was a passthrough when it was stored).
    const provisionable = {
        ...sandboxRow,
        setupCode: `c0de`,
        setupCodeExpiresAt: new Date(Date.now() + 60_000),
        setupPayload: JSON.stringify({ SANDBOX_HOSTNAME: `sandbox-abc.intentic.dev`, OWNER_EMAIL: `owner@example.com` }),
    };
    const cloudConfig = { ...context().config, scriptOrigin: `https://site.test`, api: { url: `https://api.test` } } as OrpcContext[`config`];

    it(`cloudOptions maps a rejected provider credential to BAD_REQUEST`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(``, { status: 401 })));
        await expectOrpcCode(
            call(sandboxRoutes.cloudOptions, { credentials: { provider: `hetzner`, token: `bad` } }, { context: context() }),
            `BAD_REQUEST`,
        );
    });

    it(`cloudProvision creates the machine whose first boot runs this sandbox's code, and stamps the row`, async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal(`fetch`, (_url: URL | string, init?: RequestInit): Promise<Response> => {
            bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
            return Promise.resolve(new Response(JSON.stringify({ server: { id: 42 } }), { status: 201 }));
        });
        const update = vi.fn().mockImplementation(({ data }: { data: { cloud: unknown } }) => ({ ...provisionable, cloud: data.cloud }));
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(provisionable), update } });
        const summary = await call(
            sandboxRoutes.cloudProvision,
            { sandboxId: `s1`, credentials: { provider: `hetzner`, token: `t` }, location: `fsn1`, size: `cx22` },
            { context: context({ prisma, config: cloudConfig }) },
        );
        // The machine name mirrors the sandbox-<id> hostname; the user-data is the headless one-liner with
        // THIS sandbox's code and THIS platform's URL.
        const expectedName = `intentic-${sandboxSubdomain(sandboxIdFromToken(`tok`) ?? ``)}`;
        expect(bodies[0]).toMatchObject({ name: expectedName, server_type: `cx22`, location: `fsn1` });
        expect(bodies[0]?.[`user_data`]).toContain(`sh -s -- c0de -y`);
        expect(bodies[0]?.[`user_data`]).toContain(`PLATFORM_URL=https://api.test`);
        expect(bodies[0]?.[`user_data`]).toContain(`https://site.test/connect`);
        expect(update.mock.calls[0]![0]).toMatchObject({
            data: { cloud: { provider: `hetzner`, serverId: `42`, serverName: expectedName, location: `fsn1` } },
        });
        // The summary carries the display facts (serverId stays in the row — the browser has no use for it).
        expect(summary.cloud).toEqual({ provider: `hetzner`, serverName: expectedName, location: `fsn1` });
    });

    it(`cloudProvision surfaces an unexpected provider failure as BAD_GATEWAY with its message`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.reject(new Error(`socket hang up`)));
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(provisionable) } });
        await expectOrpcCode(
            call(
                sandboxRoutes.cloudProvision,
                { sandboxId: `s1`, credentials: { provider: `digitalocean`, token: `t` }, location: `fra1`, size: `s-2vcpu-4gb` },
                { context: context({ prisma, config: cloudConfig }) },
            ),
            `BAD_GATEWAY`,
        );
    });
});
