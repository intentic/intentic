#!/usr/bin/env node
/* Mint this machine's own development CA and its localhost leaf, into this directory, on install.
 *
 * WHY THIS IS NOT COMMITTED. A CA certificate is only useful once it is in a trust store, and this one is
 * meant to go into yours — that is the whole reason it exists. A CA whose private key is published is a CA
 * that anyone can sign with: clone the repository, mint a certificate for any hostname you like, and every
 * machine that trusted the committed root accepts it. The key that used to live here was `CA:TRUE`, carried
 * no name constraints, and was valid until 2035, so it vouched for the entire DNS namespace on behalf of
 * every developer who followed the README. Generating per machine makes the private half never leave it.
 *
 * The name constraints are the second half: even on the machine that holds the key, this root is only
 * permitted to vouch for localhost and the loopback addresses. A mis-signed certificate for anything else is
 * rejected by the validator rather than by our good intentions.
 *
 * Idempotent, and run from `prepare` — so `pnpm install` is all anyone does. It regenerates when the leaf is
 * inside its last month, which also means the expiry that used to arrive as a mystery browser error now
 * heals itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const CA_KEY = join(here, `localhost-com-ca.key`);
const CA_CRT = join(here, `localhost-com-ca.crt`);
const LEAF_KEY = join(here, `localhost.key`);
const LEAF_CRT = join(here, `localhost.crt`);

const CA_DAYS = 3650;
// 825 days is the longest a leaf can live without tripping the validity ceilings browsers apply to server
// certificates. Well inside the CA's own life, and renewed automatically below.
const LEAF_DAYS = 825;
const RENEW_WITHIN_DAYS = 30;

// Only the names this root will ever be asked to vouch for. A validator that understands the constraint
// refuses anything else signed by it — including anything signed by a copy of the key.
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

const present = [CA_KEY, CA_CRT, LEAF_KEY, LEAF_CRT].every(existsSync);
const remaining = daysLeft(LEAF_CRT);
if (present && remaining !== null && remaining > RENEW_WITHIN_DAYS) {
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), `localhost-https-`));
try {
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

console.log(`localhost-https: minted a development CA for this machine, valid ${LEAF_DAYS} days.`);
console.log(`  trust ${CA_CRT} to develop without browser warnings.`);
