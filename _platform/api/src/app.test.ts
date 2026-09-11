import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { configSchema, type Config } from "./config.js";
import { testIngressConfig } from "./testing.js";
import type { Logger } from "pino";
import { Prisma, type PrismaClient } from "@intentic/prisma";

// secrets.key is empty: encrypt/decrypt pass through as plaintext (payload and tokens stay plain strings).
const config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: `cf-api`, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: testIngressConfig,
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
// The 12-hex id and hostname for connect token `tok`, derived via the shared digest (sandboxIdFromToken).
const TUNNEL_ID = createHash(`sha256`).update(`tok`).digest(`hex`).slice(0, 12);
const HOSTNAME = `sandbox-${TUNNEL_ID}.sbx.test`;

// A minted setup code: the reachability grant was signed at mint and stored in the payload, so the claim is a pure
// read.
const intenticRow = () => ({
    id: `s1`,
    token: `tok`,
    setupCodeExpiresAt: new Date(Date.now() + 60_000),
    setupPayload: JSON.stringify({
        SANDBOX_GRANT: `ig1.stored-grant`,
        INGRESS_URL: `https://ingress.sbx.test`,
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
        expect(values[`SANDBOX_GRANT`]).toBe(`ig1.stored-grant`);
        expect(values[`INGRESS_URL`]).toBe(`https://ingress.sbx.test`);
        expect(values[`SANDBOX_HOSTNAME`]).toBe(HOSTNAME);
        expect(values[`SYNC_PAIR_TOKEN`]).toMatch(/^[\w-]{20,}$/);
        expect(values[`HOST_PAIR_TOKEN`]).toMatch(/^[\w-]{20,}$/);
        // Two one-shot credentials must never share bytes: one enrolls file-sync, the other a machine agent.
        expect(values[`HOST_PAIR_TOKEN`]).not.toBe(values[`SYNC_PAIR_TOKEN`]);
        // The claim's one write clears the prior setupReport too, so a re-run never shows last time's failure.
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
            // `at` is the platform's own clock: a machine with a wrong clock must not narrate from the past.
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

    it(`404s an expired code and writes nothing: possession of a live code is the auth`, async () => {
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

const presentation = (prisma: PrismaClient, token: string | undefined) =>
    createApp(config, prisma, logger).app.request(`/sandbox/presentation`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({}),
    });

describe(`POST /sandbox/presentation`, () => {
    // A sandbox's display name and logo are columns here and nowhere in its volumes, so the daemon cannot know them
    // and a bundle could not carry them: a migrated sandbox used to arrive under its auto-name wearing that name's
    // monogram. This is the read that lets an export capture them.
    it(`answers the row's name and logo for the token's digest`, async () => {
        const findUnique = vi.fn().mockResolvedValue({ name: `radarsu-intentic`, image: `data:image/webp;base64,AA==` });
        const res = await presentation(fakePrisma({ sandbox: { findUnique } }), `tok`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: `radarsu-intentic`, image: `data:image/webp;base64,AA==` });
        // Narrower than the row on purpose: no token, no daemonUrl, nothing another lane could reuse.
        expect(findUnique).toHaveBeenCalledWith({
            where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            select: { name: true, image: true },
        });
    });

    it(`omits the logo rather than sending null when the row has none`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ name: `workspace`, image: null }) } });
        expect(await (await presentation(prisma, `tok`)).json()).toEqual({ name: `workspace` });
    });

    it(`refuses a missing token before touching the database, and 404s an unknown one`, async () => {
        const findUnique = vi.fn();
        expect((await presentation(fakePrisma({ sandbox: { findUnique } }), undefined)).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
        expect((await presentation(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null) } }), `nope`)).status).toBe(404);
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
        const findUnique = vi.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null });
        const prisma = fakePrisma({ sandbox: { findUnique, update } });

        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(200);
        // `hosted` rides along because it is half of whether this platform handed this row a grant.
        expect(findUnique).toHaveBeenCalledWith({
            where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            include: { hosted: { select: { id: true } } },
        });
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            // The refusal record clears here: a sandbox just accepted at its proper address no longer has one.
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

    it(`refuses a daemonUrl that isn't the address derived from the sandbox's own token`, async () => {
        const update = vi.fn().mockResolvedValue({});
        // setupPayload was stored by the setup mint, so the row's address is a pure derivation, known before boot.
        const row = { id: `s1`, token: `tok`, setupPayload: `{}`, daemonUrl: null, hosted: null };
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row), update } });

        const res = await announce(prisma, `tok`, `https://evil.example`);
        expect(res.status).toBe(409);
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: { announceRefusal: { announced: `evil.example`, expected: HOSTNAME } },
        });

        expect((await announce(prisma, `tok`, `https://${HOSTNAME}`)).status).toBe(200);
    });

    it(`derives the address for a hosted sandbox too, off its machine row`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const row = { id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: { id: `h1` } };
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row), update } });

        expect((await announce(prisma, `tok`, `https://evil.example`)).status).toBe(409);
        expect((await announce(prisma, `tok`, `https://${HOSTNAME}`)).status).toBe(200);
    });

    it(`derives nothing on a platform with no reachability fabric`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const row = { id: `s1`, token: `tok`, setupPayload: `{}`, daemonUrl: null, hosted: null };
        const prisma = fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(row), update } });
        const fabricless = configSchema.parse({
            database: { url: `postgres://x` },
            betterAuth: { secret: `s` },
            secrets: { key: `` },
            webOrigin: `https://app.test`,
            ingress: { ...testIngressConfig, signingKey: `` },
            log: { level: `silent`, pretty: `false` },
        });
        const res = await createApp(fabricless, prisma, logger).app.request(`/sandbox/announce`, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": `tok` },
            body: JSON.stringify({ daemonUrl: `https://self-hosted.example` }),
        });
        expect(res.status).toBe(200);
    });

    it(`pins on first announce when nothing on the row predicts the address`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const bare = { id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null };
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

// Whether the sandbox's public address answers, established by the box probing itself; separate from announce since the
// two can fail independently.
describe(`POST /sandbox/boot-report`, () => {
    it(`stores the verdict against the sandbox, stamping 'at' server-side`, async () => {
        const update = vi.fn().mockResolvedValue({});
        const findUnique = vi.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, update } });

        const res = await bootReport(prisma, `tok`, { reach: `unreachable`, detail: `its tunnel has not come up.` });
        expect(res.status).toBe(200);
        // Matched by the token's digest, exactly like announce: the same secret, the same lookup.
        expect(findUnique).toHaveBeenCalledWith({ where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } });
        expect(update).toHaveBeenCalledExactlyOnceWith({
            where: { id: `s1` },
            data: {
                bootReport: {
                    reach: `unreachable`,
                    detail: `its tunnel has not come up.`,
                    // The platform's own clock; a box with a wrong one must not narrate from the past.
                    at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                },
            },
        });
    });

    it(`accepts a bare verdict: the healthy path carries no detail`, async () => {
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

// The connect-token host-tunnel mint; provisioning itself is covered by cloudflare.test.ts, this locks the auth and
// guard paths before any Cloudflare call.

// The one Google sign-in endpoint. Pins only that the route is mounted and verifying, the only thing a unit test can
// usefully hold about it.
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
        // Anything but 404: a 404 is the plugin missing; the refusal's exact status is Google's verifier's business.
        expect(response.status).not.toBe(404);
        expect(response.status).toBeGreaterThanOrEqual(400);
    });
});

// The edge's one question back: a grant carries no expiry, so revocation has to be something the edge can ask, and 404
// is the only answer that matters.
describe(`GET /api/reachability/:sandboxId`, () => {
    const ask = (prisma: PrismaClient, sandboxId: string) => createApp(config, prisma, logger).app.request(`/api/reachability/${sandboxId}`);
    const id = `abcdef012345`;

    it(`200s a sandbox that exists, resolved by its indexed tunnel id`, async () => {
        const findUnique = vi.fn().mockResolvedValue({ id: `s1`, hosted: null });
        const res = await ask(fakePrisma({ sandbox: { findUnique } }), id);

        expect(res.status).toBe(200);
        // The lookup is the assertion: a prefix match on the digest can't use the index (sequential scan per box).
        expect(findUnique).toHaveBeenCalledWith({ where: { tunnelId: id }, select: { id: true, hosted: { select: { appName: true } } } });
    });

    it(`names the lane: a hosted sandbox's app to replay to, or the tunnel it must dial`, async () => {
        const hosted = await ask(
            fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1`, hosted: { appName: `intentic-sbx-${id}` } }) } }),
            id,
        );
        expect(await hosted.json()).toEqual({ ok: true, lane: `hosted`, app: `intentic-sbx-${id}` });

        const own = await ask(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1`, hosted: null }) } }), id);
        expect(await own.json()).toEqual({ ok: true, lane: `tunnel` });
    });

    it(`404s a sandbox that does not exist`, async () => {
        const res = await ask(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue(null) } }), id);
        expect(res.status).toBe(404);
    });

    it(`404s anything that isn't a 12-hex id, without querying`, async () => {
        const findUnique = vi.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        for (const bad of [`nope`, `ABCDEF012345`, `abcdef01234`, `abcdef0123456`, `../../etc/passwd`]) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one cheap request per shape; sequential reads clearer
            expect((await ask(prisma, bad)).status, bad).toBe(404);
        }
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`answers with no credential presented`, async () => {
        const res = await ask(fakePrisma({ sandbox: { findUnique: vi.fn().mockResolvedValue({ id: `s1`, hosted: null }) } }), id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, lane: `tunnel` });
    });
});

/* THE BODY IS BOUNDED BEFORE ANY ROUTE READS IT. The sessionless routes parse their JSON before they look
 * anything up, so without a ceiling a client could hand this process as much heap as it cared to send, one
 * request at a time, with no token. Refused as 413 with nothing looked up. */
describe(`request body limit`, () => {
    it(`413s an oversized body before the route runs`, async () => {
        const findUnique = vi.fn();
        const res = await createApp(config, fakePrisma({ sandbox: { findUnique } }), logger).app.request(`/sandbox/announce`, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": `tok` },
            body: JSON.stringify({ daemonUrl: `https://sandbox-abc.intentic.dev`, padding: `x`.repeat(1024 * 1024) }),
        });
        expect(res.status).toBe(413);
        expect(findUnique).not.toHaveBeenCalled();
    });
});
