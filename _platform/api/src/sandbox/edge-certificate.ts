import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, timingSafeEqual, X509Certificate } from "node:crypto";
import { obtainCertificate } from "@intentic/base/acme";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { DAY_MS, HOUR_MS } from "../durations.js";
import { JOB_EDGE_CERTIFICATE, runExclusive } from "../jobs-lock.js";
import { setAcmeChallenge } from "./cloudflare.js";

// The edge's certificate: the ingress zone and every name under it, ordered over DNS-01 through intentic's own Cloudflare
// zone, kept here with its keys encrypted, and handed to any edge machine presenting the platform token. One order
// serves the whole fleet, which restarts on every deploy and would otherwise spend the CA's weekly duplicate limit.

// Renewed with this much life left, as the CA advises for a ninety-day certificate.
const RENEW_WITHIN_MS = 30 * DAY_MS;

// A failed order is simply placed again on the next check.
const CHECK_EVERY_MS = 6 * HOUR_MS;

export const edgeCertificateEnabled = (config: Config): boolean =>
    config.ingress.platformToken !== `` && config.ingress.zone !== `` && config.intenticCloudflare.apiToken !== `` && config.intenticCloudflare.zone !== ``;

const newKey = (): KeyObject => generateKeyPairSync(`ec`, { namedCurve: `P-256` }).privateKey;

const pem = (key: KeyObject): string => key.export({ type: `pkcs8`, format: `pem` }).toString();

// Orders a certificate when the zone has none or its has less than RENEW_WITHIN_MS left; answers whether it ordered.
export const renewEdgeCertificate = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    order: typeof obtainCertificate = obtainCertificate,
): Promise<boolean> => {
    const { zone } = config.ingress;
    const held = await prisma.edgeCertificate.findUnique({ where: { zone } });
    if (held !== null && held.notAfter.getTime() - Date.now() > RENEW_WITHIN_MS) {
        return false;
    }
    // The account outlives its certificates: the CA keys its rate limits to it.
    const accountKey = held === null ? newKey() : createPrivateKey(decryptSecret(config, held.accountKey));
    const certificateKey = newKey();
    const { apiToken, zone: dnsZone } = config.intenticCloudflare;
    const { certificate } = await order({
        directoryUrl: config.ingress.acmeDirectory,
        accountKey,
        certificateKey,
        hostnames: [`*.${zone}`, zone],
        publishChallenge: (recordName, value) => setAcmeChallenge(apiToken, dnsZone, recordName, value),
        removeChallenge: (recordName) => setAcmeChallenge(apiToken, dnsZone, recordName, undefined),
    });
    const notAfter = new Date(new X509Certificate(certificate).validTo);
    const issued = {
        certificate,
        privateKey: encryptSecret(config, pem(certificateKey)),
        accountKey: encryptSecret(config, pem(accountKey)),
        notAfter,
        issuedAt: new Date(),
    };
    await prisma.edgeCertificate.upsert({ where: { zone }, create: { zone, ...issued }, update: issued });
    logger.info({ zone, notAfter }, `edge certificate issued`);
    return true;
};

// Boot wiring (main.ts): checked at start and every CHECK_EVERY_MS, one replica at a time.
export const startEdgeCertificate = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!edgeCertificateEnabled(config)) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_EDGE_CERTIFICATE, async () => {
            await renewEdgeCertificate(prisma, config, logger).catch((error: unknown) =>
                logger.error({ err: error }, `edge certificate: the order failed; it is placed again on the next check`),
            );
        }).catch((error: unknown) => logger.error({ err: error }, `edge certificate lock failed`));
    };
    tick();
    setInterval(tick, CHECK_EVERY_MS);
};

// Compared as digests, so neither the token's length nor its bytes leak through timing.
const sameToken = (presented: string, expected: string): boolean =>
    timingSafeEqual(createHash(`sha256`).update(presented).digest(), createHash(`sha256`).update(expected).digest());

export type EdgeCertificateAnswer =
    | { readonly status: 200; readonly body: { readonly certificate: string; readonly privateKey: string } }
    | { readonly status: 401 | 404; readonly error: string };

// What an edge machine asking with `authorization` is handed: the zone's chain and its key, or why not.
export const edgeCertificateFor = async (prisma: PrismaClient, config: Config, authorization: string | undefined): Promise<EdgeCertificateAnswer> => {
    if (!edgeCertificateEnabled(config)) {
        return { status: 404, error: `this platform issues no edge certificate` };
    }
    const presented = authorization?.startsWith(`Bearer `) === true ? authorization.slice(`Bearer `.length) : ``;
    if (!sameToken(presented, config.ingress.platformToken)) {
        return { status: 401, error: `an edge presents the platform token` };
    }
    const held = await prisma.edgeCertificate.findUnique({ where: { zone: config.ingress.zone } });
    if (held === null) {
        return { status: 404, error: `no certificate has been issued for ${config.ingress.zone} yet` };
    }
    return { status: 200, body: { certificate: held.certificate, privateKey: decryptSecret(config, held.privateKey) } };
};
