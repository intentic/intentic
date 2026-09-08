import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";

// HTTPS is required from both ends: the daemon only speaks TLS to a platform (http breaks announces with
// ERR_INVALID_PROTOCOL), and the browser needs the SPA and api same-site, which includes scheme. Nothing verifies this
// certificate by design; it is minted fresh per run so CI needs nothing prepared.

const run = promisify(execFile);

export interface Certificate {
    readonly dir: string;
    readonly keyPath: string;
    readonly certPath: string;
}

// All three hostnames this world is reached by; host.docker.internal is how the compose sandbox reaches it.
const SUBJECT_ALT_NAMES = `DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1`;

export const mintCertificate = async (): Promise<Certificate> => {
    const dir = await mkdtemp(join(tmpdir(), `intentic-onboarding-tls-`));
    const keyPath = join(dir, `key.pem`);
    const certPath = join(dir, `cert.pem`);
    try {
        // Uses `-addext` instead of a config file for the SAN.
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
        const message = errorMessage(cause);
        throw new Error(`could not mint the run's TLS certificate, openssl failed: ${message}`, { cause });
    }
    return { dir, keyPath, certPath };
};
