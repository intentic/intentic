import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { configSchema, type Config } from "./config.js";
import type { Logger } from "pino";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";

// Full config with the intentic-provided path enabled; secrets.key empty so encrypt/decrypt pass through as
// plaintext (the stored payload is plain JSON, tokens are plain strings).
const config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapDryRun: `true` },
    zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

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

// A minted setup code: the reachability grant was bought at mint (sandbox.setupCode) and stored IN the
// payload, so the claim is a pure read — it hands the box the whole grant and calls no provider at all.
const intenticRow = () => ({
    id: `s1`,
    token: `tok`,
    setupCodeExpiresAt: new Date(Date.now() + 60_000),
    zrokToken: `enc-account-token`,
    setupPayload: JSON.stringify({
        ZROK_TOKEN: `acct-token`,
        ZROK_API: `https://zrok2.sbx.test`,
        ZROK_NAMESPACE: `ns-1`,
        SANDBOX_HOSTNAME: HOSTNAME,
        OWNER_EMAIL: `owner@example.com`,
    }),
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`POST /setup/claim`, () => {
    it(`returns the mint-cached reachability grant + a pair token, with no provider call`, async () => {
        vi.stubGlobal(`fetch`, () => {
            throw new Error(`claim must call no provider — the grant is minted with the code`);
        });
        const update = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(intenticRow()), update } });

        const res = await claim(prisma);
        expect(res.status).toBe(200);
        const values = parse(await res.text());

        expect(values[`CONNECT_TOKEN`]).toBe(`tok`);
        expect(values[`ZROK_TOKEN`]).toBe(`acct-token`);
        expect(values[`ZROK_NAMESPACE`]).toBe(`ns-1`);
        expect(values[`SANDBOX_HOSTNAME`]).toBe(HOSTNAME);
        expect(values[`SYNC_PAIR_TOKEN`]).toMatch(/^[\w-]{20,}$/);
        expect(values[`HOST_PAIR_TOKEN`]).toMatch(/^[\w-]{20,}$/);
        // Two independent one-shot credentials, never the same bytes: one enrolls a file-sync agent, the other a
        // machine agent that can restart this sandbox, and a shared token would make redeeming either spend both.
        expect(values[`HOST_PAIR_TOKEN`]).not.toBe(values[`SYNC_PAIR_TOKEN`]);
        // The claim's ONE write: the stamp that tells the setup wizard the pasted command reached a machine —
        // and the previous run's setup report cleared with it, so a fixed-and-re-run machine never shows last
        // time's failure over this run's progress. Nothing else about the row moves here.
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: { setupCodeClaimedAt: expect.any(Date), setupReport: Prisma.DbNull },
        });
    });

    it(`404s an expired code with no oracle`, async () => {
        const prisma = fakePrisma({
            sandbox: { findUnique: vi.fn().mockResolvedValue({ ...intenticRow(), setupCodeExpiresAt: new Date(Date.now() - 1) }) },
        });
        const res = await claim(prisma);
        expect(res.status).toBe(404);
    });
});

const report = (prisma: PrismaClient, body: unknown) =>
    createApp(config, prisma, logger).app.request(`/setup/report`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(body),
    });

describe(`POST /setup/report`, () => {
    it(`stores the stage and failures against the sandbox, stamping 'at' server-side`, async () => {
        const update = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(intenticRow()), update } });

        const failed = [{ check: `Docker`, problem: `the docker daemon is not running.`, remedy: `start Docker, then re-run.` }];
        const res = await report(prisma, { code: `abc`, stage: `preflight`, failed });
        expect(res.status).toBe(200);
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            // `at` is the platform's own clock — a machine with a wrong clock must not narrate from the past.
            data: { setupReport: { stage: `preflight`, failed, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } },
        });
    });

    it(`accepts a bare stage transition as progress`, async () => {
        const update = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(intenticRow()), update } });

        const res = await report(prisma, { code: `abc`, stage: `pulling-image` });
        expect(res.status).toBe(200);
        expect(update.mock.calls[0]?.[0].data.setupReport.failed).toEqual([]);
    });

    it(`404s an expired code and writes nothing — possession of a live code is the auth`, async () => {
        const update = vi.fn();
        const prisma = fakePrisma({
            sandbox: { findUnique: vi.fn().mockResolvedValue({ ...intenticRow(), setupCodeExpiresAt: new Date(Date.now() - 1) }), update },
        });
        const res = await report(prisma, { code: `abc`, stage: `preflight` });
        expect(res.status).toBe(404);
        expect(update).not.toHaveBeenCalled();
    });

    it(`400s a malformed report before touching the database`, async () => {
        const findUnique = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await report(prisma, { code: `abc`, stage: `not-a-stage` })).status).toBe(400);
        expect((await report(prisma, { stage: `preflight` })).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
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
        const findUnique = vi.fn().mockResolvedValue({ id: `s1`, token: `tok`, zrokToken: null, setupPayload: null, daemonUrl: null });
        const prisma = fakePrisma({ sandbox: { findUnique, update } });

        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(200);
        expect(findUnique).toHaveBeenCalledWith({ where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } });
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            // The refusal record is cleared on the way through: it exists to describe a LIVE disagreement, and
            // a sandbox just accepted at its proper address no longer has one.
            data: { daemonUrl: `https://sandbox-abc.intentic.dev`, lastSeenAt: expect.any(Date), announceRefusal: Prisma.DbNull },
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

    /* daemonUrl is what the browser sends the user's Google credential to, unprobed — so a connect token that
     * could rewrite it would be trading a container-env secret for the owner's identity. It can't: the address
     * is one we already know, from whichever half of setup established it. */
    it(`refuses a daemonUrl that isn't the address derived from the sandbox's own token`, async () => {
        const update = vi.fn().mockResolvedValue({});
        // A provisioned row: its grant exists, so its address is a pure derivation, known before boot.
        const row = { id: `s1`, token: `tok`, zrokToken: `enc-acct`, setupPayload: null, daemonUrl: null };
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row), update } });

        const res = await announce(prisma, `tok`, `https://evil.example`);
        expect(res.status).toBe(409);
        /* Neither the URL nor lastSeenAt moves — an unvetted address must not read as a live sandbox. What IS
         * written is the disagreement itself, both halves of it: the refusal used to be a log line only, which
         * is what made a mis-addressed sandbox look exactly like one that never started. */
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: { announceRefusal: { announced: `evil.example`, expected: HOSTNAME.replace(`.intentic.dev`, `.sbx.test`) } },
        });

        // The address the platform would derive for this token, under the fabric's own zone.
        const derived = `https://${HOSTNAME.replace(`.intentic.dev`, `.sbx.test`)}`;
        expect((await announce(prisma, `tok`, derived)).status).toBe(200);
    });

    /* A row with neither record — attached by hand, or created before the hostname was stored — has nothing to
     * check against. It learns the address on the first announce and holds it from then on, so the field is
     * never free-form for longer than one write. */
    it(`pins on first announce when nothing on the row predicts the address`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const bare = { id: `s1`, token: `tok`, zrokToken: null, setupPayload: null, daemonUrl: null };
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(bare), update } });
        expect((await announce(prisma, `tok`, `https://self-hosted.example`)).status).toBe(200);

        const pinned = { ...bare, daemonUrl: `https://self-hosted.example` };
        const after = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(pinned), update } });
        expect((await announce(after, `tok`, `https://self-hosted.example`)).status).toBe(200);
        expect((await announce(after, `tok`, `https://evil.example`)).status).toBe(409);
    });
});

const bootReport = (prisma: PrismaClient, token: string | undefined, body: unknown) =>
    createApp(config, prisma, logger).app.request(`/sandbox/boot-report`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify(body),
    });

/* The announce's other half: whether the sandbox's PUBLIC address answers, as established by the box probing
 * itself. Separate from the announce because the two claims fail separately — the tunnel migration produced a
 * fleet that registered perfectly and served nobody, and nothing in the registry could tell them apart. */
describe(`POST /sandbox/boot-report`, () => {
    it(`stores the verdict against the sandbox, stamping 'at' server-side`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const findUnique = vi.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, update } });

        const res = await bootReport(prisma, `tok`, { reach: `unreachable`, detail: `its tunnel has not come up.` });
        expect(res.status).toBe(200);
        // Matched by the token's digest, exactly like the announce — the same secret, the same lookup.
        expect(findUnique).toHaveBeenCalledWith({ where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } });
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: {
                bootReport: {
                    reach: `unreachable`,
                    detail: `its tunnel has not come up.`,
                    // The platform's own clock: a box with a wrong one must not narrate from the past.
                    at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                },
            },
        });
    });

    it(`accepts a bare verdict — the healthy path carries no detail`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1` }), update } });
        expect((await bootReport(prisma, `tok`, { reach: `reachable` })).status).toBe(200);
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: { bootReport: { reach: `reachable`, at: expect.any(String) } },
        });
    });

    it(`refuses a missing token, an unknown one, and a verdict that isn't one`, async () => {
        const findUnique = vi.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, update: vi.fn() } });
        expect((await bootReport(prisma, undefined, { reach: `reachable` })).status).toBe(400);
        expect((await bootReport(prisma, `tok`, { reach: `probably` })).status).toBe(400);
        // Neither reached the database: both are refusals of the request, not of the sandbox.
        expect(findUnique).not.toHaveBeenCalled();

        const unknown = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() } });
        expect((await bootReport(unknown, `nope`, { reach: `reachable` })).status).toBe(404);
    });
});

// The connect-token host-tunnel mint (the in-sandbox infra panel's path). The CF provisioning itself is the
// shared provisionHostSshTunnel (covered by cloudflare.test.ts); these lock the auth + guard paths that run
// before any Cloudflare call.

/* THE ONE-GOOGLE-SIGN-IN ENDPOINT. The browser mints a Google ID token, signs into the platform with it, and
 * keeps the same token for its sandbox — which is what removed the second Google ask. This holds the only
 * thing a unit test can hold about it usefully: that the route is MOUNTED and verifying. It was absent
 * entirely until the one-tap plugin was added, and a missing route is indistinguishable from a broken one
 * from the browser's side — both send the user down the redirect fallback, silently, forever. */
describe(`POST /api/auth/one-tap/callback`, () => {
    const post = (idToken: string) =>
        createApp(
            { ...config, google: { clientId: `client-id.apps.googleusercontent.com`, clientSecret: `s` } } as Config,
            fakePrisma({}),
            logger,
        ).app.request(`/api/auth/one-tap/callback`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ idToken }),
        });

    it(`is mounted, and refuses a token Google did not sign`, async () => {
        const response = await post(`not-a-google-token`);
        // Anything but 404: a 404 is the plugin missing, which is the regression this exists to catch. The
        // refusal itself is Google's verifier talking, and its exact status is that library's business.
        expect(response.status).not.toBe(404);
        expect(response.status).toBeGreaterThanOrEqual(400);
    });
});
