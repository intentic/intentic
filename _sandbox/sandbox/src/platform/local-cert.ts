import { createPrivateKey, generateKeyPairSync, type KeyObject, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localHostname, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { LETS_ENCRYPT_DIRECTORY, obtainCertificate } from "./acme.js";
import { postToPlatform } from "./platform-client.js";

/* THE LOOPBACK CERTIFICATE, what lets a browser on this machine reach the daemon without Cloudflare.
 *
 * The shortcut needs HTTPS (Safari refuses http loopback from an HTTPS page as mixed content), HTTPS needs a
 * certificate, and a certificate needs a name a public CA will sign. `<id>.local.<zone>` is that name, and it
 * resolves to 127.0.0.1 under ONE wildcard record for the whole zone, so a sandbox asking for a certificate
 * costs the zone nothing permanent (@intentic/sandbox-contract localHostname says what that bought). The key
 * is generated here and never leaves; the platform is asked only for the DNS it alone holds the token for
 * (POST /sandbox/local-dns: the wildcard, asserted, and this order's own challenge).
 *
 * FAILURE IS ORDINARY AND MUST BE QUIET. No zone, no platform, an own-Cloudflare sandbox, a CA that is down, a
 * rate limit, in every case the daemon serves the loopback listener in plain HTTP instead, the browser's
 * probe notices, and Chrome and Firefox still take the shortcut while Safari uses the tunnel. Nothing here is
 * allowed to delay boot or fail a sandbox, which is why it runs detached and logs rather than throws.
 *
 * ponytail: renewal is checked on boot and daily; a sandbox left running for months renews in place, one that
 * is restarted often renews at boot. */

// Renew this far ahead of expiry. Let's Encrypt issues for 90 days and asks for renewal at 30 remaining; the
// margin also means a daemon that only restarts weekly still never serves an expired certificate.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/* How soon to try again after a FAILED issuance, as opposed to the daily check that follows a good one. A
 * sandbox that has no certificate at all is serving its shortcut over plain http, which Safari refuses, so a
 * day is far too long to sit on a failure that is usually transient.
 *
 * The floor on this interval is the CA's memory rather than politeness: a validation that missed leaves the
 * CA's resolvers holding the NXDOMAIN for the zone's SOA minimum, 1800s on Cloudflare, and retrying inside
 * that window fails again on cached evidence no matter how correct the retry is. */
const RETRY_INTERVAL_MS = 45 * 60 * 1000;

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

/* THE NAME TO CERTIFY IS THE PLATFORM'S TO GIVE, not this daemon's to derive, because the platform is the one
 * that owns the zone the record goes in.
 *
 * This used to read `<id>.local.<zoneFromUrl(publicUrl)>` — the zone of the sandbox's OWN public hostname. That
 * is right only while the two zones happen to be the same one, and they stop being the same the moment a
 * sandbox's reachability moves: on the zrok hub a sandbox answers at `sandbox-<id>.sbx.<zone>`, so this derived
 * `<id>.local.sbx.<zone>` while the platform kept writing the wildcard and the ACME challenge under `<zone>`.
 * The two names never meet, validation asks for a TXT at a name the platform never wrote, and issuance fails
 * for every migrated sandbox — quietly, because a failed loopback certificate is a supported state that just
 * drops the browser onto the plain HTTP/1.1 shortcut.
 *
 * So it is ASKED FOR instead. `POST /sandbox/local-dns` already answers with the hostname it just asserted the
 * wildcard for; taking that answer makes the platform's zone the single source of the name, and a sandbox that
 * changes public address keeps its certificate working without either side being taught about the other. */
const localCertHostname = (config: Config): string | undefined => {
    const id = sandboxIdFromToken(config.connectToken);
    const zone = zoneFromUrl(config.sandbox.publicUrl);
    return id === undefined || zone === undefined ? undefined : localHostname(id, zone);
};

/* The certificate on disk, if it still has life in it and is for the name given. `hostname` undefined means
 * "whatever this was issued for", which is what BOOT needs: the authoritative name comes from the platform and
 * boot must not wait on a network call to serve TLS it already has. A certificate for a name that has since
 * changed is caught by the renewal loop, which does know the answer, and replaced there. */
const readUsable = (config: Config, hostname: string | undefined, now: number): LocalCertificate | undefined => {
    const paths = pathsFor(config);
    try {
        const certificate = readFileSync(paths.cert, "utf8");
        const privateKey = readFileSync(paths.key, "utf8");
        const parsed = new X509Certificate(certificate);
        if (Date.parse(parsed.validTo) - now < RENEW_BEFORE_MS) {
            return undefined;
        }
        // The subject's own CN when the caller has no name to check against: a certificate always knows what it
        // is for, and reporting that is more honest than reporting a guess.
        const own = /CN=([^\n,]+)/.exec(parsed.subject)?.[1];
        if (hostname === undefined) {
            return own === undefined ? undefined : { hostname: own, certificate, privateKey };
        }
        // checkHost covers the SAN properly, a substring match on the PEM would not.
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
// connect token, so this carries only the value, a sandbox cannot ask for records outside its own name.
// Returns the hostname the platform asserted the wildcard for, which is the name to certify (see
// localCertHostname). Undefined from a platform too old to answer with one, where the derived name stands.
const relayChallenge = async (config: Config, value: string | undefined): Promise<string | undefined> => {
    const { status, json } = await postToPlatform(config, "/sandbox/local-dns", value === undefined ? {} : { challenge: value });
    if (status < 200 || status >= 300) {
        const detail = (json as { error?: string } | undefined)?.error;
        throw new Error(`the platform refused the loopback DNS update${detail === undefined ? "" : `: ${detail}`}`);
    }
    const answered = (json as { hostname?: unknown } | undefined)?.hostname;
    return typeof answered === `string` && answered !== `` ? answered : undefined;
};

/* Obtain (or renew) the certificate. Returns undefined whenever the sandbox cannot or need not have one,
 * every branch is a normal state, never an error the caller has to handle. */
const ensureLocalCertificate = async (config: Config, logger: Logger): Promise<LocalCertificate | undefined> => {
    const derived = localCertHostname(config);
    if (derived === undefined || config.platform.url === "" || config.connectToken === "") {
        return undefined;
    }
    /* Assert the wildcard and learn the authoritative name in the SAME call, before anything is compared
     * against it. It is one request either way (the record has to be re-asserted on every check regardless,
     * see below), so asking costs nothing and settles which zone this certificate belongs in. */
    const answered = await relayChallenge(config, undefined).catch((error: unknown) => {
        logger.warn({ err: error, hostname: derived }, "could not reach the platform for the loopback DNS record");
        return undefined;
    });
    const hostname = answered ?? derived;
    if (answered !== undefined && answered !== derived) {
        // Worth a line: it means this sandbox's public zone and its certificate's zone have parted company,
        // which is exactly the case the derived name got wrong.
        logger.info({ derived, hostname }, "the platform named a different loopback hostname; using its answer");
    }
    const existing = readUsable(config, hostname, Date.now());
    if (existing !== undefined) {
        /* A CERTIFICATE ON DISK IS NOT A NAME THAT RESOLVES, and conflating the two is how the shortcut dies
         * quietly for months.
         *
         * `<id>.local.<zone>` needs two things: a certificate, which lives here and lasts 90 days, and an A
         * record pointing at 127.0.0.1, which lives in the platform's zone and is written as a side effect of
         * asking for that certificate. So a valid certificate used to mean this function returned before ever
         * mentioning DNS, and the record was re-asserted only when the certificate was next reissued.
         *
         * Anything that removed the record in between therefore broke the shortcut until expiry, with nothing
         * to notice: the daemon has a certificate, serves TLS with it, logs a healthy listener, and the name it
         * is serving under resolves nowhere. The zone's own orphan reaper does exactly this to a sandbox whose
         * platform no longer lists it, which is the ordinary consequence of the owner moving to another
         * platform deployment, and a hand-edited zone or a write that failed at issuance get there too.
         *
         * Re-asserting is idempotent (the platform upserts) and costs one request per check, so the record is
         * now kept alive by the same daily loop that keeps the certificate alive, and a deleted one comes back
         * within a day rather than within a quarter. Failure is not fatal to anything: the certificate is
         * still good, the tunnel still works, and the plain-HTTP half of the loopback listener needs no DNS at
         * all, so this warns and carries on. */
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
    // The key first and 0600: a certificate on disk without its key is merely useless, the reverse is a race
    // where a concurrent read could pick up a key that does not match.
    writeFileSync(paths.key, privateKey, { mode: 0o600 });
    writeFileSync(paths.cert, certificate);
    logger.info({ hostname }, "loopback certificate issued");
    return { hostname, certificate, privateKey };
};

/* The certificate to serve the loopback listener with RIGHT NOW: whatever is already on disk, without waiting
 * on the network. Issuance is slow (a CA validating DNS takes tens of seconds) and the listener must be up
 * long before that, so boot reads and `startLocalCertificateRenewal` issues, the sandbox serving plain HTTP in
 * the meantime rather than nothing. What issuance produces is handed to the listener as it lands (`onIssued`),
 * so the wait is for the CA and not for the next restart. */
export const readLocalCertificate = (config: Config): LocalCertificate | undefined =>
    // No name to check against on purpose: the authoritative one is the platform's and boot does not wait on
    // the network to serve TLS it already holds. The certificate reports what it was issued for, and the
    // renewal loop replaces it if that has since changed.
    readUsable(config, undefined, Date.now());

/* Keep the certificate fresh in the background: once at boot (which is what issues the first one), then on a
 * cadence that depends on how the last attempt went, daily when there is a certificate to renew, far sooner
 * when there is none to serve. Never rejects: a sandbox whose certificate cannot be obtained is a working
 * sandbox on plain HTTP.
 *
 * `onIssued` receives every certificate this loop is satisfied with, including the one already on disk (which
 * the caller is by definition already serving, and re-offering costs nothing next to the branch that would
 * have to work out whether it was new). It used to receive nothing at all: the loop wrote the file and the
 * listener read that file once, at boot, so a sandbox's FIRST certificate did not take effect until something
 * restarted the daemon. A fresh sandbox has no certificate, which made "serves its shortcut over plain HTTP/1.1
 * until further notice" the normal state of every new sandbox rather than a brief window at boot. */
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
                // A handover that throws must not be read as a failed issuance: the certificate is on disk and
                // good, and re-running the CA over a listener's bad day would spend a rate limit on nothing.
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
