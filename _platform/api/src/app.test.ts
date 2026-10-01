import { createHash, createHmac } from "node:crypto";
import type { HostReportInput } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createApp } from "./app.js";
import { configSchema, type Config } from "./config.js";
import { HOST_REPORT_INTERVAL_MS } from "./sandbox/host-report.js";
import { INGRESS_TEST_PRIVATE_KEY, testIngressConfig } from "./testing.js";
import { mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { mintAdoptionTicket } from "./sandbox/recovery.js";
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

const logger = { child: () => logger, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

const fakePrisma = (sandbox: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => sandbox as unknown as PrismaClient;

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
    unstubAllGlobals();
});

describe(`POST /setup/claim`, () => {
    it(`returns the mint-cached reachability grant + a pair token, with no provider call`, async () => {
        stubGlobal(`fetch`, () => {
            throw new Error(`claim must call no provider — the grant is minted with the code`);
        });
        const update = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(intenticRow()), update } });

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
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { setupCodeClaimedAt: expect.any(Date), setupReport: Prisma.DbNull },
        });
    });

    it(`404s an expired code with no oracle`, async () => {
        const prisma = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue({ ...intenticRow(), setupCodeExpiresAt: new Date(Date.now() - 1) }) },
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
        const update = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(intenticRow()), update } });

        const failed = [{ check: `Docker`, problem: `the docker daemon is not running.`, remedy: `start Docker, then re-run.` }];
        const res = await report(prisma, { code: `abc`, stage: `preflight`, failed });
        expect(res.status).toBe(200);
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({
            where: { id: `s1` },
            // `at` is the platform's own clock: a machine with a wrong clock must not narrate from the past.
            data: { setupReport: { stage: `preflight`, failed, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } },
        });
    });

    it(`accepts a bare stage transition as progress`, async () => {
        const update = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(intenticRow()), update } });

        const res = await report(prisma, { code: `abc`, stage: `pulling-image` });
        expect(res.status).toBe(200);
        expect(update.mock.calls[0]?.[0].data.setupReport.failed).toEqual([]);
    });

    it(`404s an expired code and writes nothing: possession of a live code is the auth`, async () => {
        const update = jest.fn();
        const prisma = fakePrisma({
            sandbox: { findUnique: jest.fn().mockResolvedValue({ ...intenticRow(), setupCodeExpiresAt: new Date(Date.now() - 1) }), update },
        });
        const res = await report(prisma, { code: `abc`, stage: `preflight` });
        expect(res.status).toBe(404);
        expect(update).not.toHaveBeenCalled();
    });

    it(`400s a malformed report before touching the database`, async () => {
        const findUnique = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await report(prisma, { code: `abc`, stage: `not-a-stage` })).status).toBe(400);
        expect((await report(prisma, { stage: `preflight` })).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

// The report key for connect token `tok`, computed here rather than by the code under test. The label is a literal on
// purpose: `ic` derives the same key on the machine from the same bytes, so a changed label is a broken contract.
const REPORT_KEY = createHmac(`sha256`, `tok`).update(`intentic/host-report/v1`).digest(`hex`);
const TOKEN_DIGEST = createHash(`sha256`).update(`tok`).digest(`hex`);

// What `ic sandbox fix` sends mid-repair, with a check it is fixing.
const fixing: HostReportInput = {
    source: `agent`,
    machine: `rog`,
    os: `windows`,
    stage: `fixing`,
    doing: `Starting Docker Desktop`,
    checks: [
        { id: `prerequisites`, label: `Prerequisites`, state: `ok` },
        { id: `docker-app`, label: `Docker Desktop`, state: `fixing`, problem: `Docker Desktop is not running.`, fix: `auto` },
    ],
};

// An own-machine sandbox's row as the report route selects it; `hostReport` is whatever the last report stored.
const reportRow = (hostReport: unknown = null) => ({ id: `s1`, token: `tok`, tokenDigest: TOKEN_DIGEST, hostReport, hosted: null });

// A row holding a live fix code, as the claim selects it.
const fixRow = () => ({ id: `s1`, tunnelId: TUNNEL_ID, token: `tok`, fixCodeExpiresAt: new Date(Date.now() + 60_000), removedAt: null, hosted: null });

const claimFix = (prisma: PrismaClient, body: unknown) =>
    createApp(config, prisma, logger).app.request(`/host-report/claim`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(body),
    });

const postHostReport = (prisma: PrismaClient, key: string | undefined, body: unknown) => {
    const headers = new Headers({ "content-type": `application/json` });
    if (key !== undefined) {
        headers.set(`authorization`, `Bearer ${key}`);
    }
    return createApp(config, prisma, logger).app.request(`/host-report`, { method: `POST`, headers, body: JSON.stringify(body) });
};

describe(`POST /host-report/claim`, () => {
    it(`redeems a live fix code for the sandbox's tunnel id and its report key, and stays redeemable`, async () => {
        const findUnique = jest.fn().mockResolvedValue(fixRow());
        const update = jest.fn();
        const updateMany = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique, update, updateMany } });

        const res = await claimFix(prisma, { code: `Fix0Code123` });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sandbox: TUNNEL_ID, key: REPORT_KEY });
        expect(findUnique).toHaveBeenCalledWith({
            where: { fixCode: `Fix0Code123` },
            select: { id: true, tunnelId: true, token: true, fixCodeExpiresAt: true, removedAt: true, hosted: { select: { id: true } } },
        });
        // The owner may run the handed-out command twice: the claim spends nothing, so the second answers the same.
        const again = await claimFix(prisma, { code: `Fix0Code123` });
        expect(await again.json()).toEqual({ sandbox: TUNNEL_ID, key: REPORT_KEY });
        expect(update).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it.each([
        [`unknown`, null],
        [`expired a millisecond ago`, { ...fixRow(), fixCodeExpiresAt: new Date(Date.now() - 1) }],
        [`never minted`, { ...fixRow(), fixCodeExpiresAt: null }],
        [`on a removed sandbox`, { ...fixRow(), removedAt: new Date() }],
        [`on a hosted sandbox`, { ...fixRow(), hosted: { id: `h1` } }],
    ])(`404s a code that is %s, with the same words`, async (_case, row) => {
        const res = await claimFix(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(row) } }), { code: `Fix0Code123` });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe(`error: fix code invalid or expired`);
    });

    it(`400s a body naming no code before touching the database`, async () => {
        const findUnique = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await claimFix(prisma, {})).status).toBe(400);
        expect((await claimFix(prisma, { code: `` })).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

describe(`POST /host-report`, () => {
    it(`stores the report under the right key, stamping 'at' server-side`, async () => {
        const findUnique = jest.fn().mockResolvedValue(reportRow());
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique, updateMany } }), REPORT_KEY, { sandbox: TUNNEL_ID, report: fixing });

        expect(res.status).toBe(204);
        expect(await res.text()).toBe(``);
        // Found by the public tunnel id the report names; the key is what proves it is this sandbox's machine.
        expect(findUnique).toHaveBeenCalledWith({
            where: { tunnelId: TUNNEL_ID },
            select: { id: true, token: true, tokenDigest: true, hostReport: true, hosted: { select: { id: true } } },
        });
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            // Pinned to the token the key was checked against, like announce.
            where: { id: `s1`, tokenDigest: TOKEN_DIGEST },
            // The platform's own clock: a machine with a wrong one must not narrate from the past.
            data: { hostReport: { ...fixing, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
        });
    });

    it.each([
        [`another sandbox's key`, createHmac(`sha256`, `other`).update(`intentic/host-report/v1`).digest(`hex`)],
        [`the key with its last character changed`, `${REPORT_KEY.slice(0, -1)}${REPORT_KEY.endsWith(`0`) ? `1` : `0`}`],
        [`a prefix of the key`, REPORT_KEY.slice(0, 32)],
        [`the connect token itself`, `tok`],
    ])(`401s %s and writes nothing`, async (_case, key) => {
        const updateMany = jest.fn();
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(reportRow()), updateMany } }), key, {
            sandbox: TUNNEL_ID,
            report: fixing,
        });
        expect(res.status).toBe(401);
        expect(await res.text()).toBe(`error: that report key is not this sandbox's`);
        expect(updateMany).not.toHaveBeenCalled();
    });

    it(`answers an unknown sandbox exactly as a wrong key`, async () => {
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) } }), REPORT_KEY, {
            sandbox: `abcdef012345`,
            report: fixing,
        });
        expect(res.status).toBe(401);
        expect(await res.text()).toBe(`error: that report key is not this sandbox's`);
    });

    it(`401s a request with no key before reading the body or the database`, async () => {
        const findUnique = jest.fn();
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique } }), undefined, { sandbox: TUNNEL_ID, report: fixing });
        expect(res.status).toBe(401);
        expect(await res.text()).toBe(`error: missing report key`);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`refuses a hosted sandbox's report even under its right key`, async () => {
        const updateMany = jest.fn();
        const row = { ...reportRow(), hosted: { id: `h1` } };
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(row), updateMany } }), REPORT_KEY, {
            sandbox: TUNNEL_ID,
            report: fixing,
        });
        expect(res.status).toBe(404);
        expect(updateMany).not.toHaveBeenCalled();
    });

    it.each([
        [`a stage that isn't one`, { sandbox: TUNNEL_ID, report: { ...fixing, stage: `resting` } }],
        [`a sandbox id that isn't 12 hex`, { sandbox: TUNNEL_ID.toUpperCase(), report: fixing }],
        [`no report`, { sandbox: TUNNEL_ID }],
        [`25 checks`, { sandbox: TUNNEL_ID, report: { ...fixing, checks: Array.from({ length: 25 }, () => fixing.checks[0]) } }],
    ])(`400s %s before touching the database`, async (_case, body) => {
        const findUnique = jest.fn();
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique } }), REPORT_KEY, body);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(`error: malformed report`);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`skips a report of the same stage and outcome inside the interval, answering 204 so ic never retries`, async () => {
        const updateMany = jest.fn();
        const stored = { ...fixing, doing: `Waiting for Docker Desktop`, at: new Date().toISOString() };
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(reportRow(stored)), updateMany } }), REPORT_KEY, {
            sandbox: TUNNEL_ID,
            report: fixing,
        });
        expect(res.status).toBe(204);
        expect(updateMany).not.toHaveBeenCalled();
    });

    it.each([
        [`the stage moved`, { ...fixing, stage: `checking`, at: new Date().toISOString() }],
        [`the outcome moved`, { ...fixing, stage: `fixing`, outcome: `failed`, at: new Date().toISOString() }],
        [`the stored one is a whole interval old`, { ...fixing, at: new Date(Date.now() - HOST_REPORT_INTERVAL_MS).toISOString() }],
        [`the stored one no longer parses`, { stage: `fixing`, at: new Date().toISOString() }],
    ])(`writes inside the interval when %s`, async (_case, stored) => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(reportRow(stored)), updateMany } }), REPORT_KEY, {
            sandbox: TUNNEL_ID,
            report: fixing,
        });
        expect(res.status).toBe(204);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({ where: { id: `s1`, tokenDigest: TOKEN_DIGEST }, data: { hostReport: { ...fixing, at: expect.any(String) } } });
    });

    it(`401s a report whose sandbox's token rotated between the read and the write`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const res = await postHostReport(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(reportRow()), updateMany } }), REPORT_KEY, {
            sandbox: TUNNEL_ID,
            report: fixing,
        });
        expect(res.status).toBe(401);
        expect(updateMany).toHaveBeenCalledTimes(1);
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
        const findUnique = jest.fn().mockResolvedValue({ name: `radarsu-intentic`, image: `data:image/webp;base64,AA==` });
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
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ name: `workspace`, image: null }) } });
        expect(await (await presentation(prisma, `tok`)).json()).toEqual({ name: `workspace` });
    });

    it(`refuses a missing token before touching the database, and 404s an unknown one`, async () => {
        const findUnique = jest.fn();
        expect((await presentation(fakePrisma({ sandbox: { findUnique } }), undefined)).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
        expect((await presentation(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) } }), `nope`)).status).toBe(404);
    });
});

const announce = (prisma: PrismaClient, token: string | undefined, daemonUrl: unknown, version?: unknown) =>
    createApp(config, prisma, logger).app.request(`/sandbox/announce`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({ daemonUrl, version }),
    });

const farewell = (prisma: PrismaClient, token: string | undefined, removedBy?: unknown) =>
    createApp(config, prisma, logger).app.request(`/sandbox/farewell`, {
        method: `POST`,
        headers: { "content-type": `application/json`, ...(token === undefined ? {} : { "x-intentic-connect": token }) },
        body: JSON.stringify({ removedBy }),
    });

describe(`POST /sandbox/farewell`, () => {
    it(`stamps the removal on the row the token digests to, and drops the address`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const res = await farewell(fakePrisma({ sandbox: { updateMany } }), `tok`, `radarsu-rog`);
        expect(res.status).toBe(200);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            // The address goes because it now serves nothing; the row stays, because deleting it is the owner's press.
            data: { removedAt: expect.any(Date), removedBy: `radarsu-rog`, daemonUrl: null },
        });
    });

    it(`accepts a removal that cannot name its machine`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        await farewell(fakePrisma({ sandbox: { updateMany } }), `tok`);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ removedBy: null }) }));
    });

    it(`refuses a missing token before touching the database, and 404s an unknown one with no oracle`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const prisma = fakePrisma({ sandbox: { updateMany } });
        expect((await farewell(prisma, undefined)).status).toBe(400);
        expect(updateMany).not.toHaveBeenCalled();
        expect((await farewell(prisma, `nope`)).status).toBe(404);
    });
});

describe(`POST /sandbox/announce`, () => {
    it(`refuses an announcement whose token was revoked after its lookup`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null });
        const res = await announce(fakePrisma({ sandbox: { findUnique, updateMany } }), `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(404);
        expect(updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } }),
        );
    });
    it(`stamps daemonUrl + lastSeenAt on the row matched by the token's digest`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null });
        const prisma = fakePrisma({ sandbox: { findUnique, updateMany } });

        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(200);
        // `hosted` rides along because it is half of whether this platform handed this row a grant.
        expect(findUnique).toHaveBeenCalledWith({
            where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            include: { hosted: { select: { id: true } } },
        });
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            // The refusal record clears here: a sandbox just accepted at its proper address no longer has one. So does
            // the removal tombstone: a box announcing is a box that is here, whatever was deleted before it. A daemon
            // that names no version leaves none standing: the one stored was an earlier daemon's.
            data: {
                daemonUrl: `https://sandbox-abc.intentic.dev`,
                daemonVersion: null,
                lastSeenAt: expect.any(Date),
                announceRefusal: Prisma.DbNull,
                removedAt: null,
                removedBy: null,
            },
        });
    });

    // What the daemon says it is, stored on the row it announces for; the platform's only word on what each one runs.
    it(`stores the version the daemon names`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null });
        const res = await announce(fakePrisma({ sandbox: { findUnique, updateMany } }), `tok`, `https://sandbox-abc.intentic.dev`, `1.62.0-rc.1+build.7`);
        expect(res.status).toBe(200);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ daemonVersion: `1.62.0-rc.1+build.7` }) }));
    });

    // A version is short and semver-shaped; anything else is not trusted, and costs the announce nothing.
    it.each([[`latest`], [`1.2`], [`1.2.3 ; drop table`], [`1.2.${`9`.repeat(80)}`], [42]])(`announces but stores no version for %j`, async (version) => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null });
        const res = await announce(fakePrisma({ sandbox: { findUnique, updateMany } }), `tok`, `https://sandbox-abc.intentic.dev`, version);
        expect(res.status).toBe(200);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ daemonVersion: null }) }));
    });

    // A registry that forgot the sandbox says 404 and the daemon keeps asking; one that deleted it says 410, and that is
    // final. Only the token's holder can tell the two apart, so neither is an oracle.
    it(`410s a token whose sandbox was deleted, by the deletion record of the id it digests to`, async () => {
        const tombstone = jest.fn().mockResolvedValue({ tunnelId: TUNNEL_ID });
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) }, sandboxTombstone: { findUnique: tombstone } });
        const res = await announce(prisma, `tok`, `https://${HOSTNAME}`);
        expect(res.status).toBe(410);
        expect(await res.text()).toBe(`error: this sandbox was deleted`);
        expect(tombstone).toHaveBeenCalledWith({ where: { tunnelId: TUNNEL_ID }, select: { tunnelId: true } });
    });

    it(`answers an accepted announce with the identity of the database that took it`, async () => {
        const prisma = fakePrisma({
            sandbox: {
                findUnique: jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            platformIdentity: { findUnique: jest.fn().mockResolvedValue({ id: 1, identity: `a0028692-7cf2-4ef4-8429-86a98d60be8a`, createdAt: new Date(0) }) },
        });
        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(await res.json()).toEqual({ ok: true, identity: `a0028692-7cf2-4ef4-8429-86a98d60be8a` });
    });

    it(`still accepts the announce when the database cannot say which it is`, async () => {
        const prisma = fakePrisma({
            sandbox: {
                findUnique: jest.fn().mockResolvedValue({ id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            platformIdentity: { findUnique: jest.fn().mockRejectedValue(new Error(`relation "platform_identity" does not exist`)) },
        });
        const res = await announce(prisma, `tok`, `https://sandbox-abc.intentic.dev`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it(`404s an unknown token with no oracle`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) }, sandboxTombstone: { findUnique: jest.fn().mockResolvedValue(null) } });
        expect((await announce(prisma, `nope`, `https://sandbox-abc.intentic.dev`)).status).toBe(404);
    });

    it(`rejects missing tokens and non-https URLs before touching the database`, async () => {
        const findUnique = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        expect((await announce(prisma, undefined, `https://sandbox-abc.intentic.dev`)).status).toBe(400);
        expect((await announce(prisma, `tok`, `http://insecure.example.com`)).status).toBe(400);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`refuses a daemonUrl that isn't the address derived from the sandbox's own token`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        // setupPayload was stored by the setup mint, so the row's address is a pure derivation, known before boot.
        const row = { id: `s1`, token: `tok`, setupPayload: `{}`, daemonUrl: null, hosted: null };
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(row), updateMany } });

        const res = await announce(prisma, `tok`, `https://evil.example`);
        expect(res.status).toBe(409);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            data: { announceRefusal: { announced: `evil.example`, expected: HOSTNAME } },
        });

        expect((await announce(prisma, `tok`, `https://${HOSTNAME}`)).status).toBe(200);
    });

    it(`derives the address for a hosted sandbox too, off its machine row`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const row = { id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: { id: `h1` } };
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(row), updateMany } });

        expect((await announce(prisma, `tok`, `https://evil.example`)).status).toBe(409);
        expect((await announce(prisma, `tok`, `https://${HOSTNAME}`)).status).toBe(200);
    });

    it(`derives nothing on a platform with no reachability fabric`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const row = { id: `s1`, token: `tok`, setupPayload: `{}`, daemonUrl: null, hosted: null };
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(row), updateMany } });
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
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const bare = { id: `s1`, token: `tok`, setupPayload: null, daemonUrl: null, hosted: null };
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(bare), updateMany } });
        expect((await announce(prisma, `tok`, `https://self-hosted.example`)).status).toBe(200);

        const pinned = { ...bare, daemonUrl: `https://self-hosted.example` };
        const after = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(pinned), updateMany } });
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
    it(`refuses a boot report whose token was revoked after its lookup`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1` });
        const res = await bootReport(fakePrisma({ sandbox: { findUnique, updateMany } }), `tok`, { reach: `reachable` });
        expect(res.status).toBe(404);
        expect(updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } }),
        );
    });
    it(`stores the verdict against the sandbox, stamping 'at' server-side`, async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUnique = jest.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, updateMany } });

        const res = await bootReport(prisma, `tok`, { reach: `unreachable`, detail: `its tunnel has not come up.` });
        expect(res.status).toBe(200);
        // Matched by the token's digest, exactly like announce: the same secret, the same lookup.
        expect(findUnique).toHaveBeenCalledWith({ where: { tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) } });
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
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
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1` }), updateMany } });
        expect((await bootReport(prisma, `tok`, { reach: `reachable` })).status).toBe(200);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: `s1`, tokenDigest: createHash(`sha256`).update(`tok`).digest(`hex`) },
            data: { bootReport: { reach: `reachable`, at: expect.any(String) } },
        });
    });

    it(`refuses a missing token, an unknown one, and a verdict that isn't one`, async () => {
        const findUnique = jest.fn().mockResolvedValue({ id: `s1` });
        const prisma = fakePrisma({ sandbox: { findUnique, updateMany: jest.fn() } });
        expect((await bootReport(prisma, undefined, { reach: `reachable` })).status).toBe(400);
        expect((await bootReport(prisma, `tok`, { reach: `probably` })).status).toBe(400);
        // Neither reached the database: both are refusals of the request, not of the sandbox.
        expect(findUnique).not.toHaveBeenCalled();

        const unknown = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn() } });
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
        const findUnique = jest.fn().mockResolvedValue({ id: `s1`, hosted: null });
        const res = await ask(fakePrisma({ sandbox: { findUnique } }), id);

        expect(res.status).toBe(200);
        // The lookup is the assertion: a prefix match on the digest can't use the index (sequential scan per box).
        expect(findUnique).toHaveBeenCalledWith({ where: { tunnelId: id }, select: { id: true, hosted: { select: { id: true } } } });
    });

    // No app to replay to any more: the lane alone, kept for an edge from before the replay lane went.
    it(`names the lane and no app`, async () => {
        const hosted = await ask(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, hosted: { id: `h1` } }) } }), id);
        expect(await hosted.json()).toEqual({ ok: true, lane: `hosted` });

        const own = await ask(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, hosted: null }) } }), id);
        expect(await own.json()).toEqual({ ok: true, lane: `tunnel` });
    });

    // The one refusal: a deletion record. 404 is what the edge refuses a tunnel on, so it means exactly this.
    it(`404s a sandbox whose id has a deletion record`, async () => {
        const tombstone = jest.fn().mockResolvedValue({ tunnelId: id });
        const res = await ask(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) }, sandboxTombstone: { findUnique: tombstone } }), id);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: `deleted sandbox` });
        expect(tombstone).toHaveBeenCalledWith({ where: { tunnelId: id }, select: { tunnelId: true } });
    });

    // Absence is not deletion: a restored or foreign database knows nothing of a sandbox still holding this platform's
    // grant, and refusing it would take that sandbox off the internet within a minute of the edge asking.
    it(`serves an id it has neither a row nor a deletion record for, as unknown`, async () => {
        const res = await ask(
            fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue(null) }, sandboxTombstone: { findUnique: jest.fn().mockResolvedValue(null) } }),
            id,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, lane: `tunnel`, known: false });
    });

    it(`404s anything that isn't a 12-hex id, without querying`, async () => {
        const findUnique = jest.fn();
        const prisma = fakePrisma({ sandbox: { findUnique } });
        for (const bad of [`nope`, `ABCDEF012345`, `abcdef01234`, `abcdef0123456`, `../../etc/passwd`]) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one cheap request per shape; sequential reads clearer
            expect((await ask(prisma, bad)).status, bad).toBe(404);
        }
        expect(findUnique).not.toHaveBeenCalled();
    });

    it(`answers with no credential presented`, async () => {
        const res = await ask(fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, hosted: null }) } }), id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, lane: `tunnel` });
    });
});

// Which database the platform reads, asked by a browser before anyone signs in; a database that cannot say is a 503,
// never an identity made up for it.
describe(`GET /api/identity`, () => {
    const ask = (prisma: PrismaClient) => createApp(config, prisma, logger).app.request(`/api/identity`);

    it(`answers the database's identity and when it was given it, with no credential presented`, async () => {
        const findUnique = jest.fn().mockResolvedValue({ id: 1, identity: `a0028692-7cf2-4ef4-8429-86a98d60be8a`, createdAt: new Date(`2026-10-01T22:42:40.466Z`) });
        const res = await ask(fakePrisma({ platformIdentity: { findUnique } }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ identity: `a0028692-7cf2-4ef4-8429-86a98d60be8a`, since: `2026-10-01T22:42:40.466Z` });
    });

    it(`503s when the database cannot say`, async () => {
        const res = await ask(fakePrisma({ platformIdentity: { findUnique: jest.fn().mockRejectedValue(new Error(`connection refused`)) } }));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: `the platform's database cannot say which it is` });
    });
});

// The daemon's half of a reconnect (recovery.ts decides; this pins what the route reads and how it answers).
describe(`POST /sandbox/adopt`, () => {
    const adopt = (prisma: PrismaClient, token: string | undefined, body: Record<string, unknown>) => {
        const headers = new Headers({ "content-type": `application/json` });
        if (token !== undefined) {
            headers.set(`x-intentic-connect`, token);
        }
        return createApp(config, prisma, logger).app.request(`/sandbox/adopt`, { method: `POST`, headers, body: JSON.stringify(body) });
    };
    const body = () => ({
        ticket: mintAdoptionTicket(INGRESS_TEST_PRIVATE_KEY, { sandboxId: TUNNEL_ID, userId: `u1`, issuedAtMs: Date.now() }),
        grant: mintReachabilityGrant(INGRESS_TEST_PRIVATE_KEY, TUNNEL_ID, Date.now()),
        daemonUrl: `https://${HOSTNAME}`,
        owner: `owner@example.com`,
        name: `intentic`,
        version: `1.2.3`,
    });
    const registry = (tombstoned: boolean) => {
        const create = jest.fn().mockResolvedValue({ id: `adopted` });
        const prisma = fakePrisma({
            user: { findUnique: jest.fn().mockResolvedValue({ email: `owner@example.com` }) },
            sandbox: { findUnique: jest.fn().mockResolvedValue(null), create },
            sandboxTombstone: { findUnique: jest.fn().mockResolvedValue(tombstoned ? { tunnelId: TUNNEL_ID } : null) },
            platformIdentity: { findUnique: jest.fn().mockResolvedValue({ id: 1, identity: `id-1`, createdAt: new Date(0) }) },
        });
        return { prisma, create };
    };

    it(`makes the row again and answers with it and the database's identity`, async () => {
        const { prisma, create } = registry(false);
        const res = await adopt(prisma, `tok`, body());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, sandboxId: `adopted`, identity: `id-1` });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it(`answers a refusal with its status and reason`, async () => {
        const { prisma, create } = registry(true);
        const res = await adopt(prisma, `tok`, body());
        expect(res.status).toBe(410);
        expect(await res.text()).toBe(`error: this sandbox was deleted from intentic: restore it from the trash, or set up a new one`);
        expect(create).not.toHaveBeenCalled();
    });

    it(`refuses a missing token or a malformed body before reading the registry`, async () => {
        const { prisma, create } = registry(false);
        expect((await adopt(prisma, undefined, body())).status).toBe(400);
        const missingGrant = await adopt(prisma, `tok`, { ...body(), grant: undefined });
        expect(missingGrant.status).toBe(400);
        expect(await missingGrant.text()).toBe(`error: an adoption names its ticket, its grant and an https daemonUrl`);
        expect((await adopt(prisma, `tok`, { ...body(), daemonUrl: `http://${HOSTNAME}` })).status).toBe(400);
        expect(create).not.toHaveBeenCalled();
    });
});

/* A REQUEST THAT WAITS ON A MACHINE KEEPS ITS CONNECTION. Bun closes one that sends nothing for its idle timeout (10s by
 * default) with no response; a restart or a rollback waits minutes for the new daemon, and the owner is owed its answer. */
describe(`the idle timeout on machine changes`, () => {
    // Bun's server, as Bun.serve hands it to fetch; only the per-request timeout is read.
    const served = () => ({ timeout: jest.fn() });

    it.each([[`/rpc/sandbox/hosted-restart`], [`/rpc/sandbox/hosted-rollback`], [`/rpc/sandbox/wake`], [`/rpc/hosted-plan/tier`]])(`lifts it for %s`, async (path) => {
        const server = served();
        await createApp(config, fakePrisma({}), logger).app.request(path, { method: `POST`, body: `{}` }, server);
        expect(server.timeout).toHaveBeenCalledTimes(1);
        expect(server.timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    });

    it(`leaves it for every other route`, async () => {
        const server = served();
        await createApp(config, fakePrisma({}), logger).app.request(`/rpc/sandbox/hosted-offer`, { method: `GET` }, server);
        expect(server.timeout).not.toHaveBeenCalled();
    });
});

/* THE BODY IS BOUNDED BEFORE ANY ROUTE READS IT. */
describe(`request body limit`, () => {
    it(`413s an oversized body before the route runs`, async () => {
        const findUnique = jest.fn();
        const res = await createApp(config, fakePrisma({ sandbox: { findUnique } }), logger).app.request(`/sandbox/announce`, {
            method: `POST`,
            headers: { "content-type": `application/json`, "x-intentic-connect": `tok` },
            body: JSON.stringify({ daemonUrl: `https://sandbox-abc.intentic.dev`, padding: `x`.repeat(1024 * 1024) }),
        });
        expect(res.status).toBe(413);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

const confirmLocalDns = (prisma: PrismaClient, body: unknown) =>
    createApp(config, prisma, logger).app.request(`/sandbox/local-dns/confirm`, {
        method: `POST`,
        headers: { "content-type": `application/json`, "x-intentic-connect": `tok` },
        body: JSON.stringify(body),
    });

describe(`POST /sandbox/local-dns/confirm`, () => {
    // The loopback order's fallback proof, for a sandbox whose network cannot see Cloudflare's nameservers.
    it(`answers Cloudflare's word on the sandbox's own challenge record, and writes nothing`, async () => {
        const calls: { method: string; url: string }[] = [];
        stubGlobal(`fetch`, (url: string, init?: RequestInit): Promise<Response> => {
            calls.push({ method: init?.method ?? `GET`, url });
            const result = url.includes(`/zones?name=`) ? [{ id: `zone-1` }] : [{ content: `digest` }];
            return Promise.resolve(new Response(JSON.stringify({ success: true, errors: [], result })));
        });
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, token: `tok` }) } });

        const held = await confirmLocalDns(prisma, { challenge: `digest` });
        expect(held.status).toBe(200);
        expect(await held.json()).toEqual({ confirmed: true });
        expect(await (await confirmLocalDns(prisma, { challenge: `another` })).json()).toEqual({ confirmed: false });
        expect(calls.every((call) => call.method === `GET`)).toBe(true);
        expect(calls.at(-1)?.url).toContain(encodeURIComponent(`_acme-challenge.${TUNNEL_ID}.local.intentic.dev`));
    });

    it(`refuses a request naming no challenge`, async () => {
        const prisma = fakePrisma({ sandbox: { findUnique: jest.fn().mockResolvedValue({ id: `s1`, token: `tok` }) } });
        expect((await confirmLocalDns(prisma, {})).status).toBe(400);
    });
});
