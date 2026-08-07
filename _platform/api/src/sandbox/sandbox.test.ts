import { createHash } from "node:crypto";
import { Prisma } from "@intentic-app/prisma";
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
    tunnelToken: null,
};

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

afterEach(() => {
    vi.unstubAllGlobals();
});

// Canned Cloudflare success envelope for the tunnel fetch stubs.
const cfOk = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }));

// Canned Cloudflare error envelope (e.g. 1022 = tunnel has active connections).
const cfErr = (code: number, message: string, status = 400) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

// A Cloudflare API where the tunnel delete fails with `tunnelDelete` (its connections cleanup + zone/list all
// succeed) — for the delete-teardown error paths.
const stubTunnelDeleteFailure = (tunnelDelete: () => Response) =>
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        if (url.includes(`/zones?name=`)) {
            return Promise.resolve(cfOk([{ id: `z1`, account: { id: `a1` } }]));
        }
        if (method === `GET` && url.includes(`/cfd_tunnel?name=`)) {
            return Promise.resolve(cfOk([{ id: `t1` }]));
        }
        if (method === `DELETE` && url.endsWith(`/cfd_tunnel/t1/connections`)) {
            return Promise.resolve(cfOk({}));
        }
        if (method === `DELETE` && url.endsWith(`/cfd_tunnel/t1`)) {
            return Promise.resolve(tunnelDelete());
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
    });

const providedConfig = {
    ...context().config,
    intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapAfterDays: 0, reapDryRun: true, poolSize: 0 },
};
const providedRow = { ...sandboxRow, tunnelToken: `cached-token` };

// A happy-path Cloudflare API: one zone, tunnel t1 found by name, connector token, ingress + DNS accepted.
// Shared by the mint-provisioning, hostTunnel, and delete-teardown tests.
const stubCloudflareFetch = () =>
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        if (url.includes(`/zones?name=`)) {
            return Promise.resolve(cfOk([{ id: `z1`, account: { id: `a1` } }]));
        }
        if (method === `GET` && url.includes(`/cfd_tunnel?name=`)) {
            return Promise.resolve(cfOk([{ id: `t1` }]));
        }
        if (url.endsWith(`/cfd_tunnel/t1/token`)) {
            return Promise.resolve(cfOk(`connector-token`));
        }
        if (method === `DELETE` && url.endsWith(`/cfd_tunnel/t1/connections`)) {
            return Promise.resolve(cfOk({}));
        }
        if (method === `DELETE` && url.endsWith(`/cfd_tunnel/t1`)) {
            return Promise.resolve(cfOk({}));
        }
        if (method === `PUT` && url.endsWith(`/configurations`)) {
            return Promise.resolve(cfOk({}));
        }
        if (url.includes(`/dns_records?type=CNAME`)) {
            return Promise.resolve(cfOk([]));
        }
        if (method === `POST` && url.endsWith(`/dns_records`)) {
            return Promise.resolve(cfOk({}));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
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
        expect(update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { daemonUrl, lastSeenAt: expect.any(Date) } });
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
        });
    });

    it(`update writes only the provided fields and returns the summary with the logo`, async () => {
        const logo = `data:image/webp;base64,AA==`;
        const update = vi.fn().mockResolvedValue({ ...sandboxRow, name: `renamed`, image: logo });
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });

        const summary = await call(sandboxRoutes.update, { sandboxId: `s1`, name: `renamed` }, { context: context({ prisma }) });
        expect(update).toHaveBeenCalledWith({ where: { id: `s1` }, data: { name: `renamed` } });
        expect(summary).toMatchObject({ id: `s1`, name: `renamed`, image: logo, role: `owner` });

        await call(sandboxRoutes.update, { sandboxId: `s1`, image: logo }, { context: context({ prisma }) });
        expect(update).toHaveBeenLastCalledWith({ where: { id: `s1` }, data: { image: logo } });

        // `null` is a value, not an omission: it has to reach the row as a write, or removing a logo would be
        // silently ignored the same way an absent field is.
        await call(sandboxRoutes.update, { sandboxId: `s1`, image: null }, { context: context({ prisma }) });
        expect(update).toHaveBeenLastCalledWith({ where: { id: `s1` }, data: { image: null } });
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

    it(`setupCode 404s the intentic target when intentic-provided sandboxes are not configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow) } });
        await expectOrpcCode(
            call(sandboxRoutes.setupCode, { sandboxId: `s1`, target: { mode: `intentic` } }, { context: context({ prisma }) }),
            `NOT_FOUND`,
        );
    });

    it(`setupCode stores the own-Cloudflare picks and returns the code + hostname`, async () => {
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });

        const result = await call(
            sandboxRoutes.setupCode,
            { sandboxId: `s1`, target: { mode: `own`, zone: `example.com`, subdomain: `sandbox-abc` } },
            { context: context({ prisma }) },
        );

        expect(result.hostname).toBe(`sandbox-abc.example.com`);
        expect(result.code).toMatch(/^[\w-]{8,}$/);
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: {
                setupCode: result.code,
                setupCodeExpiresAt: expect.any(Date),
                // The claim stamp and the setup report belong to the code: a fresh command starts unclaimed
                // and unreported, so the setup wizard never narrates the previous run as this one.
                setupCodeClaimedAt: null,
                setupReport: Prisma.DbNull,
                // Stored as the (encryptable) JSON string; with no SECRETS_KEY it stays plaintext JSON. OWNER_EMAIL
                // is seeded (lowercased) so the daemon binds only the creator's Google identity as owner.
                setupPayload: JSON.stringify({ ZONE: `example.com`, SUBDOMAIN: `sandbox-abc`, OWNER_EMAIL: `owner@example.com` }),
            },
        });
    });

    it(`setupCode seeds the creator's email lowercased so the daemon binds the right owner`, async () => {
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        const mixedCase = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };

        await call(
            sandboxRoutes.setupCode,
            { sandboxId: `s1`, target: { mode: `own`, zone: `example.com`, subdomain: `sandbox-abc` } },
            { context: context({ prisma, user: mixedCase }) },
        );

        const stored = JSON.parse((update.mock.calls[0]![0] as { data: { setupPayload: string } }).data.setupPayload) as Record<string, string>;
        expect(stored[`OWNER_EMAIL`]).toBe(`owner@example.com`);
    });

    it(`setupCode provisions the intentic tunnel + DNS at mint and caches it on the row`, async () => {
        // The DNS record must exist BEFORE the wizard shows the hostname — a lookup fired before it exists
        // would negative-cache NXDOMAIN in the user's resolver chain for the zone's SOA TTL.
        stubCloudflareFetch();
        const update = vi.fn().mockResolvedValue(sandboxRow);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), update } });
        const config = {
            ...context().config,
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapAfterDays: 0, reapDryRun: true, poolSize: 0 },
        };

        const result = await call(
            sandboxRoutes.setupCode,
            { sandboxId: `s1`, target: { mode: `intentic` } },
            { context: context({ prisma, config }) },
        );

        // Deterministic digest of the connect token — the same one the CLI/browser derive.
        const id = createHash(`sha256`).update(sandboxRow.token).digest(`hex`).slice(0, 12);
        expect(result.hostname).toBe(`sandbox-${id}.intentic.dev`);
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { tunnelToken: `connector-token`, tunnelHostname: `sandbox-${id}.intentic.dev` },
        });
        const stored = JSON.parse((update.mock.lastCall![0] as { data: { setupPayload: string } }).data.setupPayload) as Record<string, string>;
        expect(stored[`SANDBOX_HOSTNAME`]).toBe(`sandbox-${id}.intentic.dev`);
    });

    it(`setupCode skips Cloudflare when the tunnel is already cached on the row`, async () => {
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`mint must not re-provision a cached tunnel`);
        });
        const row = { ...sandboxRow, tunnelToken: `cached-token` };
        const update = vi.fn().mockResolvedValue(row);
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(row), update } });
        const config = {
            ...context().config,
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapAfterDays: 0, reapDryRun: true, poolSize: 0 },
        };

        const result = await call(
            sandboxRoutes.setupCode,
            { sandboxId: `s1`, target: { mode: `intentic` } },
            { context: context({ prisma, config }) },
        );

        const id = createHash(`sha256`).update(sandboxRow.token).digest(`hex`).slice(0, 12);
        expect(result.hostname).toBe(`sandbox-${id}.intentic.dev`);
        expect(update).toHaveBeenCalledOnce();
    });

    it(`delete tears down the intentic tunnel + DNS, but leaves own-Cloudflare sandboxes' tunnels alone`, async () => {
        stubCloudflareFetch();
        const cfCalls: string[] = [];
        const original = globalThis.fetch;
        vi.stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
            cfCalls.push(`${init?.method ?? `GET`} ${url}`);
            return original(url as never, init);
        });
        const config = {
            ...context().config,
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapAfterDays: 0, reapDryRun: true, poolSize: 0 },
        };
        const deleteRow = vi.fn().mockResolvedValue({});
        const provided = fakePrisma({
            sandbox: { findFirst: vi.fn().mockResolvedValue({ ...sandboxRow, tunnelToken: `cached-token` }), delete: deleteRow },
        });
        expect(await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma: provided, config }) })).toEqual({ ok: true });
        expect(cfCalls.some((entry) => entry.startsWith(`DELETE `) && entry.includes(`/cfd_tunnel/t1`))).toBe(true);
        expect(deleteRow).toHaveBeenCalledWith({ where: { id: `s1` } });

        // Own-Cloudflare sandbox (no cached tunnelToken): the row goes, Cloudflare is never touched.
        cfCalls.length = 0;
        const own = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(sandboxRow), delete: vi.fn().mockResolvedValue({}) } });
        expect(await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma: own, config }) })).toEqual({ ok: true });
        expect(cfCalls).toEqual([]);
    });

    it(`delete removes the sandbox even when the tunnel still has live connections (1022), leaving it for the reaper`, async () => {
        stubTunnelDeleteFailure(() => cfErr(1022, `This tunnel has active connections. Please stop all cloudflared replicas.`));
        const deleteRow = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(providedRow), delete: deleteRow } });
        const ctx = context({ prisma, config: providedConfig });

        // The row is still removed (UI unblocks); the orphaned tunnel is left for the daily reaper to reap once
        // the host's connector detaches.
        expect(await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: ctx })).toEqual({ ok: true });
        expect(deleteRow).toHaveBeenCalledWith({ where: { id: `s1` } });
        expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it(`delete removes the sandbox even when the tunnel teardown fails outright`, async () => {
        stubTunnelDeleteFailure(() => cfErr(1000, `internal`, 500));
        const deleteRow = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(providedRow), delete: deleteRow } });
        const ctx = context({ prisma, config: providedConfig });

        // A confirmed removal must never be undone by a Cloudflare failure: the row goes regardless, and the
        // orphaned intentic-owned tunnel is the reaper's problem.
        expect(await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: ctx })).toEqual({ ok: true });
        expect(deleteRow).toHaveBeenCalledWith({ where: { id: `s1` } });
        expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it(`delete drops the row BEFORE the Cloudflare teardown, so a reload mid-teardown never sees it`, async () => {
        const order: string[] = [];
        vi.stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
            order.push(`cf`);
            if (url.includes(`/zones?name=`)) {
                return Promise.resolve(cfOk([{ id: `z1`, account: { id: `a1` } }]));
            }
            if ((init?.method ?? `GET`) === `GET` && url.includes(`/cfd_tunnel?name=`)) {
                return Promise.resolve(cfOk([]));
            }
            throw new Error(`unexpected fetch: ${init?.method ?? `GET`} ${url}`);
        });
        const prisma = fakePrisma({
            sandbox: {
                findFirst: vi.fn().mockResolvedValue(providedRow),
                delete: vi.fn().mockImplementation(() => {
                    order.push(`row`);
                    return Promise.resolve({});
                }),
            },
        });

        await call(sandboxRoutes.delete, { sandboxId: `s1` }, { context: context({ prisma, config: providedConfig }) });
        expect(order[0]).toBe(`row`);
    });

    it(`creates a second sandbox for an owner who already has one — there is no cap`, async () => {
        const create = vi.fn().mockResolvedValue({ ...sandboxRow, id: `s2` });
        const prisma = fakePrisma({ sandbox: { create } });
        const summary = await call(sandboxRoutes.create, { name: `second` }, { context: context({ prisma }) });
        expect(summary).toMatchObject({ id: `s2`, role: `owner` });
    });

    it(`flags providedTunnel only for a daemonUrl under the configured intentic zone`, async () => {
        const rows = [
            { ...sandboxRow, id: `s1`, daemonUrl: `https://sandbox-abc.intentic.dev` },
            { ...sandboxRow, id: `s2`, daemonUrl: `https://sandbox-def.example.com` },
            { ...sandboxRow, id: `s3` },
        ];
        const config = {
            intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev` },
            secrets: { key: `` },
        } as OrpcContext[`config`];
        const prisma = fakePrisma({
            sandbox: { findMany: vi.fn().mockResolvedValueOnce(rows) },
            sandboxMember: { findMany: vi.fn().mockResolvedValue([]) },
        });

        const { sandboxes } = await call(sandboxRoutes.list, undefined, { context: context({ prisma, config }) });
        expect(sandboxes.map((sandbox) => sandbox.providedTunnel)).toEqual([true, false, false]);

        // The zone alone defaults even when the feature is off (no token) — it must not flag on its own.
        const tokenless = {
            intenticCloudflare: { apiToken: ``, zone: `intentic.dev` },
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

    it(`cloudProvision refuses without a live setup code, and refuses an own-Cloudflare code`, async () => {
        const stale = { ...sandboxRow, setupCode: `c0de`, setupCodeExpiresAt: new Date(Date.now() - 1) };
        const prisma = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(stale) } });
        await expectOrpcCode(
            call(
                sandboxRoutes.cloudProvision,
                { sandboxId: `s1`, credentials: { provider: `hetzner`, token: `t` }, location: `fsn1`, size: `cx22` },
                { context: context({ prisma }) },
            ),
            `BAD_REQUEST`,
        );

        const ownCf = { ...provisionable, setupPayload: JSON.stringify({ ZONE: `example.com`, SUBDOMAIN: `sandbox-abc` }) };
        const prismaOwn = fakePrisma({ sandbox: { findFirst: vi.fn().mockResolvedValue(ownCf) } });
        await expectOrpcCode(
            call(
                sandboxRoutes.cloudProvision,
                { sandboxId: `s1`, credentials: { provider: `hetzner`, token: `t` }, location: `fsn1`, size: `cx22` },
                { context: context({ prisma: prismaOwn }) },
            ),
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
