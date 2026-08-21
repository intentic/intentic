#!/usr/bin/env node
/* Mint this machine's development CA and the localhost leaf under it, on install. Both land outside the
 * repository, in this user's own data directory: see paths.mjs for why they belong together there.
 *
 * WHY THE CA IS NOT COMMITTED. A CA certificate is only useful once it is in a trust store, and this one is
 * meant to go into yours: that is the whole reason it exists. A CA whose private key is published is a CA
 * that anyone can sign with: clone the repository, mint a certificate for any hostname you like, and every
 * machine that trusted the committed root accepts it. The key that used to live here was `CA:TRUE`, carried
 * no name constraints, and was valid until 2035, so it vouched for the entire DNS namespace on behalf of
 * every developer who followed the README. Generating per machine makes the private half never leave it.
 *
 * The name constraints are the second half: even on the machine that holds the key, this root is only
 * permitted to vouch for localhost and the loopback addresses. A mis-signed certificate for anything else is
 * rejected by the validator rather than by our good intentions.
 *
 * THE ROOT AND THE LEAF RENEW SEPARATELY, which is the difference between "approve it once" being true and
 * being nearly true. The root is good for ten years and is the only thing a trust store ever sees; the leaf
 * lives 825 days under it and is re-signed in place. Throwing the root away with the leaf would silently
 * revoke the approval you gave it and hand you back the browser warning, so nothing here does that unless the
 * root itself is missing or genuinely expiring, and when it does, it says so.
 *
 * Idempotent, and run from `prepare`, so `pnpm install` is all anyone does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CA_CRT, CA_DIR, CA_KEY, LEAF_CRT, LEAF_KEY } from "./paths.mjs";

const CA_DAYS = 3650;
// 825 days is the longest a leaf can live without tripping the validity ceilings browsers apply to server
// certificates. Well inside the CA's own life, and renewed automatically below.
const LEAF_DAYS = 825;
const RENEW_WITHIN_DAYS = 30;

// Only the names this root will ever be asked to vouch for. A validator that understands the constraint
// refuses anything else signed by it: including anything signed by a copy of the key.
const PERMITTED = `permitted;DNS:localhost,permitted;DNS:localhost.com,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`;

const openssl = (...args) => execFileSync(`openssl`, args, { stdio: [`ignore`, `pipe`, `pipe`] });

/** Days until the certificate stops being valid, or null when there is no readable certificate there. */
const daysLeft = (path) => {
    if (!existsSync(path)) return null;
    const notAfter = openssl(`x509`, `-in`, path, `-noout`, `-enddate`).toString().trim().replace(`notAfter=`, ``);
    const expires = Date.parse(notAfter);
    if (Number.isNaN(expires)) return null;
    return (expires - Date.now()) / 86_400_000;
};

/** Is this certificate still usable: present, readable, and not inside its renewal window? */
const fresh = (path) => {
    const remaining = daysLeft(path);
    return remaining !== null && remaining > RENEW_WITHIN_DAYS;
};

const mintCa = () => {
    mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
    // `-addext` rather than a config file: `openssl req -config` wants a whole req section before it will
    // read an extension one, and every line of that is boilerplate this does not otherwise need.
    openssl(
        `req`,
        `-x509`,
        `-newkey`,
        `rsa:2048`,
        `-noenc`,
        `-days`,
        String(CA_DAYS),
        `-subj`,
        `/C=PL/O=intentic development/CN=localhost.com`,
        `-addext`,
        `basicConstraints=critical,CA:TRUE,pathlen:0`,
        `-addext`,
        `keyUsage=critical,keyCertSign,cRLSign`,
        `-addext`,
        `nameConstraints=critical,${PERMITTED}`,
        `-keyout`,
        CA_KEY,
        `-out`,
        CA_CRT,
    );
};

const mintLeaf = () => {
    // The directory already exists whenever the root does; creating it here covers the leaf-only path, where a
    // pair was minted before and only the certificate needs re-signing.
    mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(tmpdir(), `localhost-https-`));
    try {
        // The leaf the API and Vite actually serve. The browser matches on the SAN; the subject CN has not been
        // consulted by anything shipping for years.
        writeFileSync(
            join(scratch, `leaf.ext`),
            [
                `basicConstraints=critical,CA:FALSE`,
                `keyUsage=critical,digitalSignature,keyEncipherment`,
                `extendedKeyUsage=serverAuth`,
                `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1`,
            ].join(`\n`),
        );
        openssl(`req`, `-newkey`, `rsa:2048`, `-noenc`, `-subj`, `/CN=localhost`, `-keyout`, LEAF_KEY, `-out`, join(scratch, `leaf.csr`));
        openssl(
            `x509`,
            `-req`,
            `-in`,
            join(scratch, `leaf.csr`),
            `-CA`,
            CA_CRT,
            `-CAkey`,
            CA_KEY,
            `-CAcreateserial`,
            `-days`,
            String(LEAF_DAYS),
            `-extfile`,
            join(scratch, `leaf.ext`),
            `-out`,
            LEAF_CRT,
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

/* Is the leaf on disk actually serveable? Freshness is not enough, and two different things go wrong:
 *
 * It may not chain: a checkout carrying a leaf signed by a root this machine no longer has (a workspace
 * copied from elsewhere, a root that was regenerated) serves a chain the browser cannot build, which looks
 * exactly like the warning this package exists to prevent.
 *
 * Or the pair may not match. A certificate and a key that came from different mintings verify perfectly well
 * on their own and fail only when a TLS handshake tries to use them together, which surfaces as the dev server
 * refusing to start with an error about the key: far from anything that suggests certificates. Comparing the
 * public halves catches it here, where the fix is to re-sign. */
const leafUsable = () => {
    if (!existsSync(LEAF_CRT) || !existsSync(LEAF_KEY)) return false;
    try {
        openssl(`verify`, `-CAfile`, CA_CRT, LEAF_CRT);
        return openssl(`x509`, `-in`, LEAF_CRT, `-noout`, `-pubkey`).equals(openssl(`pkey`, `-in`, LEAF_KEY, `-pubout`));
    } catch {
        return false;
    }
};

const caExisted = existsSync(CA_KEY) && fresh(CA_CRT);
if (!caExisted) {
    mintCa();
}
if (!caExisted || !fresh(LEAF_CRT) || !leafUsable()) {
    mintLeaf();
}

if (caExisted) {
    process.exit(0);
}

console.log(`localhost-https: minted this machine's development CA, valid ${CA_DAYS} days.`);
console.log(`  ${CA_CRT}`);
console.log(`  Run \`pnpm cert:trust\` once to approve it: then every checkout on this machine serves https with no browser warning.`);
