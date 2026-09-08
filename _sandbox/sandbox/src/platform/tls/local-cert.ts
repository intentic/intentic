import { createPrivateKey, generateKeyPairSync, type KeyObject, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../../env.config.js";
import { LETS_ENCRYPT_DIRECTORY, obtainCertificate } from "./acme.js";
import { postToPlatform } from "../platform-client.js";

// Loopback certificate: lets a browser on this machine reach the daemon over HTTPS without Cloudflare, using
// `<id>.local.<zone>` (one wildcard record) resolving to 127.0.0.1. Failure (no zone, CA down, rate limit) is quiet:
// the daemon falls back to plain HTTP rather than delay boot or fail the sandbox.

// Renew this far before expiry; the margin covers a daemon that only restarts weekly.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Floor is the CA's own negative-cache window (the zone's SOA minimum), not politeness.
const RETRY_INTERVAL_MS = 45 * 60 * 1000;

export interface LocalCertificate {
    readonly hostname: string;
    readonly certificate: string;
    readonly privateKey: string;
}

// Outside /work and on the volume that survives a recreate, so a restart doesn't re-issue.
const pathsFor = (config: Config): { dir: string; cert: string; key: string; account: string } => {
    const dir = join(config.historyRoot, "local-cert");
    return { dir, cert: join(dir, "fullchain.pem"), key: join(dir, "key.pem"), account: join(dir, "account-key.pem") };
};

// Certificate on disk if it still has life and matches `hostname`; undefined means whatever it was issued for, since
// boot must not wait on the network to serve TLS it already has.
const readUsable = (config: Config, hostname: string | undefined, now: number): LocalCertificate | undefined => {
    const paths = pathsFor(config);
    try {
        const certificate = readFileSync(paths.cert, "utf8");
        const privateKey = readFileSync(paths.key, "utf8");
        const parsed = new X509Certificate(certificate);
        if (Date.parse(parsed.validTo) - now < RENEW_BEFORE_MS) {
            return undefined;
        }
        // Falls back to the cert's own CN when there's no name to check against.
        const own = /CN=([^\n,]+)/.exec(parsed.subject)?.[1];
        if (hostname === undefined) {
            return own === undefined ? undefined : { hostname: own, certificate, privateKey };
        }
        // checkHost covers the SAN properly; a substring match on the PEM would not.
        return parsed.checkHost(hostname) === undefined ? undefined : { hostname, certificate, privateKey };
    } catch {
        return undefined;
    }
};

// Reused across issuances, so the CA sees one account per sandbox, not a new registration each renewal.
const accountKeyOf = (config: Config): KeyObject => {
    const paths = pathsFor(config);
    try {
        return createPrivateKey(readFileSync(paths.account, "utf8"));
    } catch {
        const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.account, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
        return privateKey;
    }
};

// Writes/withdraws the DNS-01 record via the platform, keyed off our connect token. Also the only source of the name to
// certify, since the platform alone owns the zone; undefined means the loopback path is off.
const relayChallenge = async (config: Config, value: string | undefined): Promise<string | undefined> => {
    const { status, json } = await postToPlatform(config, "/sandbox/local-dns", value === undefined ? {} : { challenge: value });
    if (status < 200 || status >= 300) {
        const detail = (json as { error?: string } | undefined)?.error;
        throw new Error(`the platform refused the loopback DNS update${detail === undefined ? "" : `: ${detail}`}`);
    }
    const answered = (json as { hostname?: unknown } | undefined)?.hostname;
    return typeof answered === `string` && answered !== `` ? answered : undefined;
};

// Obtains or renews the certificate; undefined means the sandbox cannot or need not have one — every branch here is a
// normal state, not an error.
const ensureLocalCertificate = async (config: Config, logger: Logger): Promise<LocalCertificate | undefined> => {
    if (config.platform.url === "" || config.connectToken === "") {
        return undefined;
    }
    // Learns the name while asserting the wildcard; a check reasserts anyway, so this call costs nothing extra.
    const hostname = await relayChallenge(config, undefined).catch((error: unknown) => {
        logger.warn({ err: error }, "could not reach the platform for the loopback DNS record");
        return undefined;
    });
    if (hostname === undefined) {
        return undefined;
    }
    const existing = readUsable(config, hostname, Date.now());
    if (existing !== undefined) {
        // A valid cert doesn't mean its DNS record still resolves; re-asserted every check, not only at issuance.
        await relayChallenge(config, undefined).catch((error: unknown) => {
            logger.warn({ err: error, hostname }, "could not re-assert the loopback DNS record, the certified shortcut may not resolve");
        });
        return existing;
    }
    const paths = pathsFor(config);
    const certificateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    logger.info({ hostname }, "requesting the loopback certificate");
    const { certificate } = await obtainCertificate({
        directoryUrl: config.acmeDirectoryUrl === "" ? LETS_ENCRYPT_DIRECTORY : config.acmeDirectoryUrl,
        accountKey: accountKeyOf(config),
        certificateKey,
        hostnames: [hostname],
        publishChallenge: async (_recordName, value) => void (await relayChallenge(config, value)),
        removeChallenge: async () => void (await relayChallenge(config, undefined)),
    });
    const privateKey = certificateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(paths.dir, { recursive: true });
    // Key first, and 0600: a cert without its key is useless, but the reverse risks a mismatched concurrent read.
    writeFileSync(paths.key, privateKey, { mode: 0o600 });
    writeFileSync(paths.cert, certificate);
    logger.info({ hostname }, "loopback certificate issued");
    return { hostname, certificate, privateKey };
};

// Whatever is already on disk, without waiting on the network: issuance is slow, and the listener must be up long
// before a CA validates. `onIssued` hands the listener whatever issuance later produces.
export const readLocalCertificate = (config: Config): LocalCertificate | undefined =>
    // No name to check on purpose: the authoritative one is the platform's, not worth a network wait at boot.
    readUsable(config, undefined, Date.now());

// Keeps the certificate fresh in the background, daily once issued and sooner if not; never rejects, so a failure just
// means plain HTTP. `onIssued` fires for every certificate this is satisfied with, including one already on disk.
export const startLocalCertificateRenewal = (
    config: Config,
    logger: Logger,
    onIssued: (certificate: LocalCertificate) => void,
): { stop: () => void } => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = (delay: number): void => {
        if (stopped) {
            return;
        }
        timer = setTimeout(attempt, delay);
        // Never hold the process open for a renewal check.
        timer.unref?.();
    };
    function attempt(): void {
        void ensureLocalCertificate(config, logger)
            .then((certificate) => {
                // A handover that throws isn't a failed issuance: the cert is already good.
                if (certificate !== undefined) {
                    try {
                        onIssued(certificate);
                    } catch (error: unknown) {
                        logger.warn({ err: error }, "the loopback listener refused the certificate, it will serve plain http until restart");
                    }
                }
                schedule(CHECK_INTERVAL_MS);
            })
            .catch((error: unknown) => {
                logger.warn({ err: error }, "the loopback certificate is unavailable, this sandbox serves its shortcut over plain http");
                schedule(RETRY_INTERVAL_MS);
            });
    }
    attempt();
    return {
        stop: () => {
            stopped = true;
            clearTimeout(timer);
        },
    };
};
