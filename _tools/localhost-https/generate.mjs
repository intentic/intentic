#!/usr/bin/env node
// Mints a per-machine dev CA and localhost leaf on install, kept outside the repo. Never committed: a shared CA private
// key can forge a cert for any hostname on any machine that trusts it; name constraints also cap it to
// localhost/loopback. Root and leaf renew independently so a leaf re-sign never revokes browser trust.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CA_CRT, CA_DIR, CA_KEY, LEAF_CRT, LEAF_KEY } from "./paths.mjs";

const CA_DAYS = 3650;
// Longest a leaf can live under browsers' certificate-validity ceilings; well inside the CA's own life.
const LEAF_DAYS = 825;
const RENEW_WITHIN_DAYS = 30;

// Only names this root may vouch for; a constraint-aware validator refuses anything else it signs.
const PERMITTED = `permitted;DNS:localhost,permitted;DNS:localhost.com,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`;

// Windows lacks openssl on PATH by default, so pnpm install would otherwise die on an opaque ENOENT here.
const MISSING_OPENSSL = [
    `localhost-https: needs \`openssl\` on PATH to mint this machine's development certificate, and did not find it.`,
    `  Windows: Git for Windows ships one — add C:\\Program Files\\Git\\usr\\bin to PATH, or run the install from Git Bash.`,
    `  Linux: install your distribution's openssl package. macOS: it is already there.`,
].join(`\n`);

const openssl = (...args) => {
    try {
        return execFileSync(`openssl`, args, { stdio: [`ignore`, `pipe`, `pipe`] });
    } catch (cause) {
        if (cause.code === `ENOENT`) {
            throw new Error(MISSING_OPENSSL, { cause });
        }
        throw cause;
    }
};

/** Days until the certificate stops being valid, or null when there is no readable certificate there. */
const daysLeft = (path) => {
    if (!existsSync(path)) {
        return null;
    }
    const notAfter = openssl(`x509`, `-in`, path, `-noout`, `-enddate`).toString().trim().replace(`notAfter=`, ``);
    const expires = Date.parse(notAfter);
    if (Number.isNaN(expires)) {
        return null;
    }
    return (expires - Date.now()) / 86_400_000;
};

/** Is this certificate still usable: present, readable, and not inside its renewal window? */
const fresh = (path) => {
    const remaining = daysLeft(path);
    return remaining !== null && remaining > RENEW_WITHIN_DAYS;
};

const mintCa = () => {
    mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
    // -addext, not -config: openssl req -config needs a whole req section just to read one extension.
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
    // Covers the leaf-only path: the dir exists whenever the root does, but a re-sign-only run needs it too.
    mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(tmpdir(), `localhost-https-`));
    try {
        // Browser matches on the SAN; no shipping browser still consults the subject CN.
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

// Checks two ways a fresh-looking leaf can still be broken: signed by a root this machine no longer has (won't chain),
// or paired with a key from a different minting (verifies alone, fails only at the TLS handshake).
const leafUsable = () => {
    if (!existsSync(LEAF_CRT) || !existsSync(LEAF_KEY)) {
        return false;
    }
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
