import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/* THE WORLD IS SERVED OVER HTTPS, and that is the product's requirement rather than this tier's taste.
 *
 * Two things insist on it, from opposite ends:
 *
 *   The DAEMON only ever speaks to a platform over TLS. Its outbound channel is `node:https` by hand rather
 *   than fetch (platform-post.ts explains: undici cannot skip verification per request, and the global escape
 *   hatch would also disable it for Google and Anthropic). A plain-http platform makes every announce fail with
 *   ERR_INVALID_PROTOCOL, so the sandbox comes up perfectly and the wizard waits forever.
 *
 *   The BROWSER needs the SPA and the api to stay same-site, and modern same-site comparison includes the
 *   scheme. An http page calling an https api is cross-site, so the session cookie stops riding and a signed-in
 *   journey looks exactly like a broken login. So both ends move together, not one.
 *
 * Nothing verifies this certificate and nothing is meant to: the daemon skips verification for loopback and
 * `host.docker.internal` by design, the browser is told to ignore certificate errors, and the claim the wizard
 * renders already carries `curl -k` for a local platform. It is minted per run rather than borrowed from the
 * developer's own pair so that a CI runner needs nothing prepared.
 */

const run = promisify(execFile);

export interface Certificate {
    readonly dir: string;
    readonly keyPath: string;
    readonly certPath: string;
}

/* The three names this world is reached by, all in one certificate.
 *
 * `host.docker.internal` is not decoration: it is how a container on some OTHER network, the sandbox the
 * compose file starts, reaches this platform, and it is one of the three hostnames the daemon will skip
 * verification for. */
const SUBJECT_ALT_NAMES = `DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1`;

export const mintCertificate = async (): Promise<Certificate> => {
    const dir = await mkdtemp(join(tmpdir(), `intentic-onboarding-tls-`));
    const keyPath = join(dir, `key.pem`);
    const certPath = join(dir, `cert.pem`);
    try {
        // `-addext` rather than a config file, the same way the repository's own localhost certificate is minted.
        await run(
            `openssl`,
            [
                `req`,
                `-x509`,
                `-newkey`,
                `rsa:2048`,
                `-noenc`,
                `-days`,
                `2`,
                `-subj`,
                `/CN=localhost`,
                `-addext`,
                `subjectAltName=${SUBJECT_ALT_NAMES}`,
                `-keyout`,
                keyPath,
                `-out`,
                certPath,
            ],
            { timeout: 60_000 },
        );
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`could not mint the run's TLS certificate, openssl failed: ${message}`, { cause });
    }
    return { dir, keyPath, certPath };
};
