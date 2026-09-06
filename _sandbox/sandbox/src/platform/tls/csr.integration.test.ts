import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { base64Url, buildCsr } from "./csr.js";

/* Hand-rolled ASN.1 is exactly the kind of code that looks right and is wrong by one byte, and the CA that
 * would tell us is rate-limited and not available from a test. So the oracle here is OPENSSL: it parses the
 * DER independently, checks the self-signature, and reads back the SAN. If openssl accepts the request, Let's
 * Encrypt's parser will too: that is what makes this module verifiable rather than merely plausible. */

const dir = mkdtempSync(join(tmpdir(), "csr-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

// Run openssl over a CSR, returning its text dump. `-verify` makes openssl check the signature over the
// request info: the part a length or tag mistake would break. Both streams, because openssl reports the
// verify result on stderr and the parsed structure on stdout.
const openssl = (csr: Uint8Array, name: string): string => {
    const path = join(dir, `${name}.der`);
    writeFileSync(path, csr);
    const result = spawnSync("openssl", ["req", "-inform", "DER", "-in", path, "-noout", "-text", "-verify"], { encoding: "utf8" });
    // A non-zero exit is openssl refusing the DER outright: surface it rather than asserting on empty output.
    expect(result.status, `openssl rejected the request:\n${result.stderr}`).toBe(0);
    return `${result.stdout}\n${result.stderr}`;
};

it("produces a request openssl parses and whose self-signature verifies", () => {
    const dump = openssl(buildCsr(key, ["0f310c3c4db4.local.intentic.dev"]), "one");
    expect(dump).toMatch(/(?:Certificate request self-signature verify OK|verify OK)/);
    expect(dump).toContain("id-ecPublicKey");
    expect(dump).toContain("ecdsa-with-SHA256");
    // The SAN is the whole identity of the request: an empty subject is deliberate, not an omission.
    expect(dump).toContain("DNS:0f310c3c4db4.local.intentic.dev");
    expect(dump).toMatch(/Subject:\s*$/m);
});

it("keeps the long-form length encoding honest past the 127-byte boundary", () => {
    // A single long hostname pushes the SAN, and with it every enclosing SEQUENCE: over 0x7f, which is where
    // a short-form length would silently truncate the structure. openssl reading the name back proves it did not.
    const long = `local-${"a".repeat(120)}.intentic.dev`;
    expect(openssl(buildCsr(key, [long]), "long")).toContain(`DNS:${long}`);
});

it("carries every requested hostname, in order", () => {
    const dump = openssl(buildCsr(key, ["a.intentic.dev", "b.intentic.dev"]), "two");
    expect(dump).toContain("DNS:a.intentic.dev, DNS:b.intentic.dev");
});

it("refuses to build a request that identifies nothing", () => {
    // A CSR with an empty subject AND no SAN names nobody; failing here beats a CA rejecting it later.
    expect(() => buildCsr(key, [])).toThrowError(/at least one hostname/);
});

it("base64url-encodes without padding, as ACME's finalize expects", () => {
    const encoded = base64Url(buildCsr(key, ["0f310c3c4db4.local.intentic.dev"]));
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
});
