import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { base64Url, buildCsr } from "./csr.js";

// Hand-rolled ASN.1 fails silently by one byte; openssl is the independent oracle here (parses the DER, checks the
// self-signature, reads the SAN) since a real CA isn't available in tests.

const dir = mkdtempSync(join(tmpdir(), "csr-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

// Dumps a CSR via openssl; `-verify` checks the signature over the request info, the part a length/tag mistake would
// break. Captures both streams: verify result on stderr, structure on stdout.
const openssl = (csr: Uint8Array, name: string): string => {
    const path = join(dir, `${name}.der`);
    writeFileSync(path, csr);
    const result = spawnSync("openssl", ["req", "-inform", "DER", "-in", path, "-noout", "-text", "-verify"], { encoding: "utf8" });
    // Non-zero exit means openssl refused the DER outright; surfaced here instead of failing on empty output.
    expect(result.status, `openssl rejected the request:\n${result.stderr}`).toBe(0);
    return `${result.stdout}\n${result.stderr}`;
};

it("produces a request openssl parses and whose self-signature verifies", () => {
    const dump = openssl(buildCsr(key, ["0f310c3c4db4.local.intentic.dev"]), "one");
    expect(dump).toMatch(/(?:Certificate request self-signature verify OK|verify OK)/);
    expect(dump).toContain("id-ecPublicKey");
    expect(dump).toContain("ecdsa-with-SHA256");
    // SAN is the request's whole identity; an empty subject is deliberate, not an omission.
    expect(dump).toContain("DNS:0f310c3c4db4.local.intentic.dev");
    expect(dump).toMatch(/Subject:\s*$/m);
});

it("keeps the long-form length encoding honest past the 127-byte boundary", () => {
    // Pushes the SAN and its enclosing SEQUENCEs past 0x7f, where short-form length would truncate silently.
    const long = `local-${"a".repeat(120)}.intentic.dev`;
    expect(openssl(buildCsr(key, [long]), "long")).toContain(`DNS:${long}`);
});

it("carries every requested hostname, in order", () => {
    const dump = openssl(buildCsr(key, ["a.intentic.dev", "b.intentic.dev"]), "two");
    expect(dump).toContain("DNS:a.intentic.dev, DNS:b.intentic.dev");
});

it("refuses to build a request that identifies nothing", () => {
    // Empty subject and no SAN names nobody; failing here beats a CA rejecting it later.
    expect(() => buildCsr(key, [])).toThrowError(/at least one hostname/);
});

it("base64url-encodes without padding, as ACME's finalize expects", () => {
    const encoded = base64Url(buildCsr(key, ["0f310c3c4db4.local.intentic.dev"]));
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
});
