import { createHash, createPrivateKey, createSign } from "node:crypto";
import { CloudCredentialError } from "./common.js";

/* OCI request signing (the draft-cavage HTTP Signature scheme Oracle's API mandates) in plain node:crypto,
 * ~60 lines against an SDK dependency the platform must not grow (../cloudflare.ts stance). The scheme, per
 * Oracle's "Request Signatures" doc:
 *
 *   keyId          = <tenancyOcid>/<userOcid>/<fingerprint>
 *   signing string = one `<header>: <value>` line per signed header, in header-list order, where the
 *                    pseudo-header `(request-target)` is `<lowercase method> <path?query>`
 *   signed headers = `date (request-target) host`, plus `content-length content-type x-content-sha256`
 *                    (base64 SHA-256 of the body) on POST/PUT/PATCH
 *   signature      = base64(RSA-SHA256 over the signing string), carried in an Authorization header:
 *                    Signature version="1",keyId="…",algorithm="rsa-sha256",headers="…",signature="…"
 *
 * The credential is the console's "add API key" config snippet + the key PEM, parsed here, a malformed
 * paste must fail as a named CloudCredentialError at parse time, not as an opaque 401 later. */

export interface OciCredential {
    readonly user: string;
    readonly tenancy: string;
    readonly fingerprint: string;
    readonly region: string;
    readonly privateKeyPem: string;
}

// The console snippet is INI-ish: `key=value` lines under an optional [DEFAULT] section, with a key_file
// line pointing at a path on the user's machine, irrelevant here, the PEM is pasted separately.
export const parseOciConfig = (config: string, privateKeyPem: string): OciCredential => {
    const values = new Map<string, string>();
    for (const line of config.split(`\n`)) {
        const trimmed = line.trim();
        if (trimmed === `` || trimmed.startsWith(`[`) || trimmed.startsWith(`#`)) {
            continue;
        }
        const eq = trimmed.indexOf(`=`);
        if (eq > 0) {
            values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
        }
    }
    const missing = [`user`, `tenancy`, `fingerprint`, `region`].filter((key) => !values.get(key));
    if (missing.length > 0) {
        throw new CloudCredentialError(
            `The Oracle config snippet is missing ${missing.join(`, `)} — paste the whole block the console shows under Profile → API keys → View configuration file.`,
        );
    }
    // Parse the PEM now so a truncated paste (or a passphrase-protected key, which the console never emits)
    // is named here rather than surfacing as a signature failure.
    try {
        createPrivateKey(privateKeyPem);
    } catch {
        throw new CloudCredentialError(
            `The Oracle private key is not a readable PEM — paste the full unencrypted key file the console had you download.`,
        );
    }
    return {
        user: values.get(`user`) ?? ``,
        tenancy: values.get(`tenancy`) ?? ``,
        fingerprint: values.get(`fingerprint`) ?? ``,
        region: values.get(`region`) ?? ``,
        privateKeyPem,
    };
};

// The exact string that gets signed, its composition is the testable half of the scheme, so it is its own
// export: one wrong space here is a 401 with no further diagnostics from Oracle.
export const signingString = (headers: readonly (readonly [string, string])[]): string =>
    headers.map(([name, value]) => `${name}: ${value}`).join(`\n`);

// The headers for one signed request: what fetch must send, Authorization included. `date` is injectable for
// tests; body presence (not method) decides the content headers, matching what is actually transmitted.
export const signedHeaders = (credential: OciCredential, method: string, url: URL, body?: string, date = new Date()): Record<string, string> => {
    const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
    const pairs: [string, string][] = [
        [`date`, date.toUTCString()],
        [`(request-target)`, target],
        [`host`, url.host],
    ];
    if (body !== undefined) {
        pairs.push(
            [`content-length`, String(Buffer.byteLength(body))],
            [`content-type`, `application/json`],
            [`x-content-sha256`, createHash(`sha256`).update(body).digest(`base64`)],
        );
    }
    const signature = createSign(`RSA-SHA256`).update(signingString(pairs)).sign(credential.privateKeyPem, `base64`);
    const keyId = `${credential.tenancy}/${credential.user}/${credential.fingerprint}`;
    const headerList = pairs.map(([name]) => name).join(` `);
    return {
        ...Object.fromEntries(pairs.filter(([name]) => name !== `(request-target)` && name !== `host`)),
        authorization: `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headerList}",signature="${signature}"`,
    };
};
