import { createPrivateKey, generateKeyPairSync, type KeyObject, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localHostname, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { LETS_ENCRYPT_DIRECTORY, obtainCertificate } from "./acme.js";
import { postToPlatform } from "./platform-client.js";

/* THE LOOPBACK CERTIFICATE — what lets a browser on this machine reach the daemon without Cloudflare.
 *
 * The shortcut needs HTTPS (Safari refuses http loopback from an HTTPS page as mixed content), HTTPS needs a
 * certificate, and a certificate needs a name a public CA will sign. `local-<id>.<zone>` is that name: a real
 * DNS record under the sandbox's zone that resolves to 127.0.0.1. The key is generated here and never leaves;
 * the platform is asked only to write two DNS records it alone has the token for (POST /sandbox/local-dns).
 *
 * FAILURE IS ORDINARY AND MUST BE QUIET. No zone, no platform, an own-Cloudflare sandbox, a CA that is down, a
 * rate limit — in every case the daemon serves the loopback listener in plain HTTP instead, the browser's
 * probe notices, and Chrome and Firefox still take the shortcut while Safari uses the tunnel. Nothing here is
 * allowed to delay boot or fail a sandbox, which is why it runs detached and logs rather than throws.
 *
 * ponytail: renewal is checked on boot and daily; a sandbox left running for months renews in place, one that
 * is restarted often renews at boot. */

// Renew this far ahead of expiry. Let's Encrypt issues for 90 days and asks for renewal at 30 remaining; the
// margin also means a daemon that only restarts weekly still never serves an expired certificate.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LocalCertificate {
    readonly hostname: string;
    readonly certificate: string;
    readonly privateKey: string;
}

// Daemon-private and persistent, beside the session secret: outside /work (never the agent's to read or an
// agent turn's to commit) and on the volume that survives a recreate, so a restart does not re-issue.
const pathsFor = (config: Config): { dir: string; cert: string; key: string; account: string } => {
    const dir = join(config.historyRoot, "local-cert");
    return { dir, cert: join(dir, "fullchain.pem"), key: join(dir, "key.pem"), account: join(dir, "account-key.pem") };
};

// The name this sandbox's loopback listener is certified for, or undefined when it cannot have one — no
// connect token (nothing to derive an id from) or no public URL to read a zone off (a loopback/dev daemon).
export const localCertHostname = (config: Config): string | undefined => {
    const id = sandboxIdFromToken(config.connectToken);
    const zone = zoneFromUrl(config.sandbox.publicUrl);
    return id === undefined || zone === undefined ? undefined : localHostname(id, zone);
};

// The certificate on disk, if it is for the name we currently want and still has life in it. Anything else —
// missing, unreadable, a different hostname (the sandbox moved zones), expiring — reads as "no certificate",
// which is the signal to issue.
const readUsable = (config: Config, hostname: string, now: number): LocalCertificate | undefined => {
    const paths = pathsFor(config);
    try {
        const certificate = readFileSync(paths.cert, "utf8");
        const privateKey = readFileSync(paths.key, "utf8");
        const parsed = new X509Certificate(certificate);
        if (Date.parse(parsed.validTo) - now < RENEW_BEFORE_MS) {
            return undefined;
        }
        // checkHost covers the SAN properly — a substring match on the PEM would not.
        return parsed.checkHost(hostname) === undefined ? undefined : { hostname, certificate, privateKey };
    } catch {
        return undefined;
    }
};

// The ACME account key, reused across issuances so the CA sees one account per sandbox rather than a new
// registration on every renewal (which is itself rate-limited).
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

// Ask the platform to write (or withdraw) the DNS-01 record. The hostname is derived platform-side from our
// connect token, so this carries only the value — a sandbox cannot ask for records outside its own name.
const relayChallenge = async (config: Config, value: string | undefined): Promise<void> => {
    const { status, json } = await postToPlatform(config, "/sandbox/local-dns", value === undefined ? {} : { challenge: value });
    if (status < 200 || status >= 300) {
        const detail = (json as { error?: string } | undefined)?.error;
        throw new Error(`the platform refused the loopback DNS update${detail === undefined ? "" : `: ${detail}`}`);
    }
};

/* Obtain (or renew) the certificate. Returns undefined whenever the sandbox cannot or need not have one —
 * every branch is a normal state, never an error the caller has to handle. */
export const ensureLocalCertificate = async (config: Config, logger: Logger): Promise<LocalCertificate | undefined> => {
    const hostname = localCertHostname(config);
    if (hostname === undefined || config.platform.url === "" || config.connectToken === "") {
        return undefined;
    }
    const existing = readUsable(config, hostname, Date.now());
    if (existing !== undefined) {
        return existing;
    }
    const paths = pathsFor(config);
    const certificateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    logger.info({ hostname }, "requesting the loopback certificate");
    // Create the A record before the order: the CA does not resolve it, but the browser will the moment the
    // certificate exists, and a name that certifies before it resolves is a shortcut that probes as dead.
    await relayChallenge(config, undefined);
    const { certificate } = await obtainCertificate({
        directoryUrl: config.acmeDirectoryUrl === "" ? LETS_ENCRYPT_DIRECTORY : config.acmeDirectoryUrl,
        accountKey: accountKeyOf(config),
        certificateKey,
        hostnames: [hostname],
        publishChallenge: async (_recordName, value) => relayChallenge(config, value),
        removeChallenge: async () => relayChallenge(config, undefined),
    });
    const privateKey = certificateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(paths.dir, { recursive: true });
    // The key first and 0600: a certificate on disk without its key is merely useless, the reverse is a race
    // where a concurrent read could pick up a key that does not match.
    writeFileSync(paths.key, privateKey, { mode: 0o600 });
    writeFileSync(paths.cert, certificate);
    logger.info({ hostname }, "loopback certificate issued");
    return { hostname, certificate, privateKey };
};

/* The certificate to serve the loopback listener with RIGHT NOW: whatever is already on disk, without waiting
 * on the network. Issuance is slow (a CA validating DNS takes tens of seconds) and the listener must be up
 * long before that, so boot reads, `startLocalCertificateRenewal` issues, and a newly-issued certificate is
 * picked up at the next restart — the sandbox is serving plain HTTP in the meantime, not nothing. */
export const readLocalCertificate = (config: Config): LocalCertificate | undefined => {
    const hostname = localCertHostname(config);
    return hostname === undefined ? undefined : readUsable(config, hostname, Date.now());
};

// Keep the certificate fresh in the background: once at boot (which is what issues the first one) and daily
// after. Never rejects — a sandbox whose certificate cannot be obtained is a working sandbox on plain HTTP.
export const startLocalCertificateRenewal = (config: Config, logger: Logger): { stop: () => void } => {
    const attempt = (): void => {
        void ensureLocalCertificate(config, logger).catch((error: unknown) => {
            logger.warn({ err: error }, "the loopback certificate is unavailable — this sandbox serves its shortcut over plain http");
        });
    };
    attempt();
    const timer = setInterval(attempt, CHECK_INTERVAL_MS);
    // Never hold the process open for a renewal check.
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
