import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

// Full config with the intentic-provided path enabled; secrets.key empty so encrypt/decrypt pass through as
// plaintext (the stored payload is plain JSON, tokens are plain strings).
const config = {
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    stripe: { secretKey: ``, webhookSecret: ``, proPriceId: `` },
    email: { apiKey: ``, from: `` },
    permanentPremiumEmails: [],
    intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapAfterDays: 7, reapDryRun: false, poolSize: 0 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: false },
} as Config;

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const fakePrisma = (sandbox: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => sandbox as unknown as PrismaClient;

const claim = (prisma: PrismaClient) =>
    createApp(config, prisma, logger).app.request(`/setup/claim`, {
        method: `POST`,
        headers: { "content-type": `application/x-www-form-urlencoded` },
        body: `code=abc`,
    });

const parse = (text: string): Record<string, string> =>
    Object.fromEntries(text.split(`\n`).map((line) => [line.slice(0, line.indexOf(`=`)), line.slice(line.indexOf(`=`) + 1)]));
// The deterministic hostname the mint stored for connect token `tok` (same digest provisionSandboxTunnel derives).
const HOSTNAME = `sandbox-${createHash(`sha256`).update(`tok`).digest(`hex`).slice(0, 12)}.intentic.dev`;

// An intentic-mode setup code: the payload carries SANDBOX_HOSTNAME (the mode marker); the tunnel was
// provisioned + cached at mint (sandbox.setupCode), so the row always holds tunnelToken by claim time.
const intenticRow = () => ({
    id: `s1`,
    token: `tok`,
    setupCodeExpiresAt: new Date(Date.now() + 60_000),
    tunnelToken: `cached-token`,
    setupPayload: JSON.stringify({ SANDBOX_HOSTNAME: HOSTNAME, OWNER_EMAIL: `owner@example.com` }),
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`POST /setup/claim`, () => {
    it(`returns the mint-cached TUNNEL_TOKEN + a pair token without any Cloudflare call`, async () => {
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`claim must not call Cloudflare — the tunnel is provisioned at mint`);
        });
        const update = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(intenticRow()), update } });

        const res = await claim(prisma);
        expect(res.status).toBe(200);
        const values = parse(await res.text());

        expect(values[`CONNECT_TOKEN`]).toBe(`tok`);
        expect(values[`TUNNEL_TOKEN`]).toBe(`cached-token`);
        expect(values[`SANDBOX_HOSTNAME`]).toBe(HOSTNAME);
        expect(values[`SYNC_PAIR_TOKEN`]).toMatch(/^[\w-]{20,}$/);
        expect(update).not.toHaveBeenCalled();
    });

    it(`404s an expired code with no oracle`, async () => {
        const prisma = fakePrisma({
            sandbox: { findUnique: vi.fn().mockResolvedValue({ ...intenticRow(), setupCodeExpiresAt: new Date(Date.now() - 1) }) },
        });
        const res = await claim(prisma);
        expect(res.status).toBe(404);
    });
});

const announce = (prisma: PrismaClient, token: string | undefined, daemonUrl: unknown) =>
    createApp(config, prisma, logger).app.request(`/sandbox/announce`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({ daemonUrl }),
    });

describe(`POST /sandbox/announce`, () => {
    it(`stamps daemonUrl + lastSeenAt on the row matched by the token's digest`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const findUnique = vi.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, update } });

        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(200);
        expect(findUnique).toHaveBeenCalledWith({ where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } });
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { daemonUrl: `https://sandbox-abc.intentic.dev`, lastSeenAt: expect.any(Date) },
        });
    });

    it(`404s an unknown token with no oracle`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null) } });
        expect((await announce(prisma, `nope`, `https://sandbox-abc.intentic.dev`)).status).toBe(404);
    });

    it(`rejects missing tokens and non-https URLs before touching the database`, async () => {
        const findUnique = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await announce(prisma, undefined, `https://sandbox-abc.intentic.dev`)).status).toBe(400);
        expect((await announce(prisma, `tok`, `http://insecure.example.com`)).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

const hostTunnel = (prisma: PrismaClient, token: string | undefined, hostName: unknown, cfg: Config = config) =>
    createApp(cfg, prisma, logger).app.request(`/sandbox/host-tunnel`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({ hostName }),
    });

// The connect-token host-tunnel mint (the in-sandbox infra panel's path). The CF provisioning itself is the
// shared provisionHostSshTunnel (covered by cloudflare.test.ts); these lock the auth + guard paths that run
// before any Cloudflare call.
describe(`POST /sandbox/host-tunnel`, () => {
    it(`rejects a missing token / hostName before the database`, async () => {
        const findUnique = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await hostTunnel(prisma, undefined, `prod`)).status).toBe(400);
        expect((await hostTunnel(prisma, `tok`, ``)).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`404s an unknown token with no oracle`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null) } });
        expect((await hostTunnel(prisma, `nope`, `prod`)).status).toBe(404);
    });

    it(`404s when intentic-provided tunnels are not configured`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1`, token: `tok` }) } });
        const disabled = { ...config, intenticCloudflare: { ...config.intenticCloudflare, apiToken: ``, zone: `` } } as Config;
        const res = await hostTunnel(prisma, `tok`, `prod`, disabled);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: `intentic-provided tunnels are not enabled` });
    });
});

const previewRoute = (prisma: PrismaClient, token: string | undefined, labels: unknown, cfg: Config = config) =>
    createApp(cfg, prisma, logger).app.request(`/sandbox/preview-route`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({ labels }),
    });

// The connect-token preview-route mint (the daemon's boot-sweep / panel-start / port-forward relay). The CF
// provisioning itself is ensurePreviewRoutes (covered by cloudflare.test.ts); these lock the auth + guard
// paths and the own-Cloudflare no-op that run before any Cloudflare call.
describe(`POST /sandbox/preview-route`, () => {
    it(`rejects a missing token / an empty batch / any non-preview, non-DNS-safe or over-long label before the database`, async () => {
        const findUnique = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await previewRoute(prisma, undefined, [`preview-app`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, `preview-app`)).status).toBe(400); // bare string, not an array
        expect((await previewRoute(prisma, `tok`, [``])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`preview-App`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`preview-my.repo`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`preview-my_repo`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`preview--app`])).status).toBe(400);
        // Only the two preview schemes mint — an arbitrary label could shadow sandbox-/ssh- hostnames.
        expect((await previewRoute(prisma, `tok`, [`app`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`sandbox-app`])).status).toBe(400);
        // One bad label poisons the whole batch.
        expect((await previewRoute(prisma, `tok`, [`preview-app`, `sandbox-app`])).status).toBe(400);
        expect((await previewRoute(prisma, `tok`, [`preview-${`a`.repeat(43)}`])).status).toBe(400);
        expect(
            (
                await previewRoute(
                    prisma,
                    `tok`,
                    Array.from({ length: 65 }, (_, i) => `preview-a${i}`),
                )
            ).status,
        ).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
        // The `<repo>--<app>` panel key, a port slot, a mixed batch, and the 50-char boundary are valid (fail
        // later, at the missing row).
        const prisma404 = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null) } });
        expect((await previewRoute(prisma404, `tok`, [`preview-shop--web`])).status).toBe(404);
        expect((await previewRoute(prisma404, `tok`, [`preview-app`, `port-a`])).status).toBe(404);
        expect((await previewRoute(prisma404, `tok`, [`preview-${`a`.repeat(42)}`])).status).toBe(404);
    });

    it(`no-ops for an own-Cloudflare sandbox (no cached tunnelToken) without any Cloudflare call`, async () => {
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`own-Cloudflare previews ride the wildcard — no Cloudflare call expected`);
        });
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1`, token: `tok`, tunnelToken: null }) } });
        const res = await previewRoute(prisma, `tok`, [`preview-app`]);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it(`404s when intentic-provided tunnels are not configured, 502s a Cloudflare failure`, async () => {
        const row = { id: `s1`, token: `tok`, tunnelToken: `ct` };
        const disabled = { ...config, intenticCloudflare: { ...config.intenticCloudflare, apiToken: ``, zone: `` } } as Config;
        expect(
            (await previewRoute(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row) } }), `tok`, [`preview-app`], disabled)).status,
        ).toBe(404);

        vi.stubGlobal(`fetch`, () => Promise.reject(new Error(`cloudflare down`)));
        const res = await previewRoute(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row) } }), `tok`, [`preview-app`]);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: `cloudflare down` });
    });
});
