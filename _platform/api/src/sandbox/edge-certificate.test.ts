import { generateKeyPairSync } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { edgeCertificateFor, renewEdgeCertificate } from "./edge-certificate.js";

// One order for the whole edge fleet: placed when the zone has no certificate or its has under a month left, published
// through intentic's own zone, and handed only to a caller presenting the platform token.

// A real certificate for *.sbx.test, valid 90 days from when this file was written; only its dates are read.
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBnDCCAUKgAwIBAgIUClpoKd4fH00/zxtq/GFDH9Cull4wCgYIKoZIzj0EAwIw\nEzERMA8GA1UEAwwIc2J4LnRlc3QwHhcNMjYwOTI0MTc0NjMxWhcNMjYxMjIzMTc0\nNjMxWjATMREwDwYDVQQDDAhzYngudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEH\nA0IABD1wRCqluuawdEeF/fnvqkxqMtQDYwGD7+zPArACi2/YGDDDn4R6kZW8LJol\nmhLmsOGV6G5GrwLVspWdrJOmiSqjdDByMB0GA1UdDgQWBBQUEvxUZQkl61ekff2x\nOL66Z+ul8jAfBgNVHSMEGDAWgBQUEvxUZQkl61ekff2xOL66Z+ul8jAPBgNVHRMB\nAf8EBTADAQH/MB8GA1UdEQQYMBaCCiouc2J4LnRlc3SCCHNieC50ZXN0MAoGCCqG\nSM49BAMCA0gAMEUCIGzx8oxgC55zgGO/KUfgmh5qL+aaRjd7eDttWWINfcCqAiEA\nkxXZTFGAYqNnFaHoorz/wzOP4idWXecFkVhwJDMdx20=\n-----END CERTIFICATE-----\n";
const NOT_AFTER = new Date(`2026-12-23T17:46:31Z`);

const config = (over: Partial<Config[`ingress`]> = {}): Config =>
    ({
        secrets: { key: `` },
        intenticCloudflare: { apiToken: `cf`, zone: `example.test` },
        ingress: { zone: `sbx.test`, url: `https://ingress.sbx.test`, signingKey: ``, platformToken: `edge-token`, acmeDirectory: `https://ca.test/directory`, ...over },
    }) as unknown as Config;

type Row = { zone: string; certificate: string; privateKey: string; accountKey: string; notAfter: Date; issuedAt: Date };

// The one table this touches, held in memory.
const store = (initial?: Row) => {
    let row = initial;
    const prisma = {
        edgeCertificate: {
            findUnique: async () => row ?? null,
            upsert: async ({ create }: { create: Row }) => {
                row = create;
                return row;
            },
        },
    } as unknown as PrismaClient;
    return { prisma, held: () => row };
};

const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;

const pem = () => generateKeyPairSync(`ec`, { namedCurve: `P-256` }).privateKey.export({ type: `pkcs8`, format: `pem` }).toString();

describe(`renewEdgeCertificate`, () => {
    it(`orders the zone and every name under it when none is held, and keeps the chain with its keys`, async () => {
        const { prisma, held } = store();
        const order = jest.fn(async (options: Parameters<typeof import("@intentic/base/acme").obtainCertificate>[0]) => {
            expect(options.hostnames).toEqual([`*.sbx.test`, `sbx.test`]);
            expect(options.directoryUrl).toBe(`https://ca.test/directory`);
            return { certificate: CERTIFICATE };
        });
        expect(await renewEdgeCertificate(prisma, config(), logger, order)).toBe(true);
        expect(order).toHaveBeenCalledTimes(1);
        expect(held()?.certificate).toBe(CERTIFICATE);
        expect(held()?.notAfter).toEqual(NOT_AFTER);
        expect(held()?.privateKey).toContain(`PRIVATE KEY`);
    });

    it(`leaves a certificate with more than a month to run alone, and renews one with less, on the same account`, async () => {
        const accountKey = pem();
        const now = Date.now();
        const fresh = { zone: `sbx.test`, certificate: CERTIFICATE, privateKey: pem(), accountKey, notAfter: new Date(now + 60 * 86_400_000), issuedAt: new Date(now) };
        const order = jest.fn(async () => ({ certificate: CERTIFICATE }));
        expect(await renewEdgeCertificate(store(fresh).prisma, config(), logger, order)).toBe(false);
        expect(order).not.toHaveBeenCalled();

        const ageing = store({ ...fresh, notAfter: new Date(now + 10 * 86_400_000) });
        expect(await renewEdgeCertificate(ageing.prisma, config(), logger, order)).toBe(true);
        expect(ageing.held()?.accountKey).toBe(accountKey);
    });
});

describe(`edgeCertificateFor`, () => {
    const issued = { zone: `sbx.test`, certificate: CERTIFICATE, privateKey: `the key`, accountKey: `the account`, notAfter: NOT_AFTER, issuedAt: NOT_AFTER };

    it(`hands the chain and its key to a caller presenting the platform token`, async () => {
        expect(await edgeCertificateFor(store(issued).prisma, config(), `Bearer edge-token`)).toEqual({
            status: 200,
            body: { certificate: CERTIFICATE, privateKey: `the key` },
        });
    });

    it(`refuses any other caller, and says so when nothing is issued or the platform issues nothing`, async () => {
        expect((await edgeCertificateFor(store(issued).prisma, config(), `Bearer another`)).status).toBe(401);
        expect((await edgeCertificateFor(store(issued).prisma, config(), undefined)).status).toBe(401);
        expect((await edgeCertificateFor(store().prisma, config(), `Bearer edge-token`)).status).toBe(404);
        expect((await edgeCertificateFor(store(issued).prisma, config({ platformToken: `` }), `Bearer `)).status).toBe(404);
    });
});
