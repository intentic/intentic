import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { parsePublicKey, parseSignature, verifyMinisign, verifySignedSums } from "./release-signature.js";

// Minisign as release-signature.ts reads it: both signature algorithms, both encodings (minisign's text, Tauri's base64
// of it), and every way a signature can fail to be the release key's over these bytes for this release.

interface TestKey {
    readonly privateKey: KeyObject;
    readonly id: Buffer;
    readonly publicText: string;
}

const testKey = (): TestKey => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
    const id = randomBytes(8);
    const shownId = Buffer.from([...id].toReversed())
        .toString("hex")
        .toUpperCase();
    const publicText = `untrusted comment: minisign public key: ${shownId}\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
    return { privateKey, id, publicText };
};

// A minisign signature file, made the way minisign (and Tauri's signer) make one.
const minisign = (data: Uint8Array, key: TestKey, algorithm: "Ed" | "ED", trustedComment: string): string => {
    const signed = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    const signature = sign(null, signed, key.privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
    return [
        `untrusted comment: signature from a test key`,
        Buffer.concat([Buffer.from(algorithm), key.id, signature]).toString("base64"),
        `trusted comment: ${trustedComment}`,
        global.toString("base64"),
        ``,
    ].join("\n");
};

const tauri = (text: string): string => Buffer.from(text).toString("base64");

const SUMS = Buffer.from(`${"a".repeat(64)}  ./ic-linux-amd64\n${"b".repeat(64)}  ./intentic-machine-linux-amd64\n`);
const COMMENT = `timestamp:1792100025\tfile:SHA256SUMS\tversion:1.338.0`;

describe("a minisign signature", () => {
    const key = testKey();

    it("verifies in both algorithms, prehashed (ED, Tauri's) and legacy (Ed), and answers its trusted comment", () => {
        for (const algorithm of ["ED", "Ed"] as const) {
            expect(verifyMinisign(SUMS, parseSignature(minisign(SUMS, key, algorithm, COMMENT)), parsePublicKey(key.publicText))).toBe(COMMENT);
        }
    });

    it("reads Tauri's base64 of the files as the files themselves", () => {
        expect(verifyMinisign(SUMS, parseSignature(tauri(minisign(SUMS, key, "ED", COMMENT))), parsePublicKey(tauri(key.publicText)))).toBe(COMMENT);
    });

    it("fails for a file changed by one byte", () => {
        const signature = parseSignature(minisign(SUMS, key, "ED", COMMENT));
        const changed = Buffer.from(SUMS);
        changed[0] = "c".charCodeAt(0);
        expect(() => verifyMinisign(changed, signature, parsePublicKey(key.publicText))).toThrow("does not match the file");
    });

    it("fails for a trusted comment rewritten after signing", () => {
        const text = minisign(SUMS, key, "ED", COMMENT).replace("version:1.338.0", "version:1.999.0");
        expect(() => verifyMinisign(SUMS, parseSignature(text), parsePublicKey(key.publicText))).toThrow("trusted comment");
    });

    it("fails for another key, by its id, and for another key wearing this key's id", () => {
        const other = testKey();
        expect(() => verifyMinisign(SUMS, parseSignature(minisign(SUMS, other, "ED", COMMENT)), parsePublicKey(key.publicText))).toThrow(
            "not the release key",
        );
        const impostor = { ...other, id: key.id };
        expect(() => verifyMinisign(SUMS, parseSignature(minisign(SUMS, impostor, "ED", COMMENT)), parsePublicKey(key.publicText))).toThrow(
            "does not match the file",
        );
    });

    it("refuses what is not a minisign key or signature", () => {
        expect(() => parsePublicKey("hello")).toThrow("not a minisign Ed25519 public key");
        expect(() => parseSignature("hello")).toThrow("not a minisign signature");
        const unknown = minisign(SUMS, key, "ED", COMMENT).replace(/^(.*\n)(.*)/, (_whole, first: string, line: string) => {
            const raw = Buffer.from(line, "base64");
            raw.write("XX", 0, "latin1");
            return `${first}${raw.toString("base64")}`;
        });
        expect(() => parseSignature(unknown)).toThrow(`algorithm "XX"`);
    });
});

describe("the release's signed SHA256SUMS", () => {
    const key = testKey();

    it("is accepted signed for SHA256SUMS of exactly this release", () => {
        expect(() => verifySignedSums(SUMS, tauri(minisign(SUMS, key, "ED", COMMENT)), tauri(key.publicText), "1.338.0")).not.toThrow();
    });

    // An older release's signed sums vouch for older binaries; served for a newer tag they must not be believed.
    it("is refused for another release, or for another file", () => {
        const signature = minisign(SUMS, key, "ED", COMMENT);
        expect(() => verifySignedSums(SUMS, signature, key.publicText, "1.339.0")).toThrow("for release 1.338.0, not 1.339.0");
        const forInstaller = minisign(SUMS, key, "ED", `timestamp:1\tfile:Intentic_1.338.0_x64-setup.exe\tversion:1.338.0`);
        expect(() => verifySignedSums(SUMS, forInstaller, key.publicText, "1.338.0")).toThrow("not SHA256SUMS");
        const unversioned = minisign(SUMS, key, "ED", `timestamp:1\tfile:SHA256SUMS`);
        expect(() => verifySignedSums(SUMS, unversioned, key.publicText, "1.338.0")).toThrow("(none named)");
    });

    // What `tauri signer sign --app-version 1.338.0 SHA256SUMS` wrote with a throwaway key (tauri signer generate), so
    // the reader is held to the real signer's output and not only to this file's idea of it.
    it("verifies a signature Tauri's own signer made", () => {
        const publicKey =
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENGOUI1NDlGQzM3MTJGMTEKUldRUkwzSERuMVNiendEWjFqaHY0a2ZGRHVZenFVSHpoVVpBZDlndkZkZGZJMi9kZDFKK1liVFoK";
        const signature =
            "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUkwzSERuMVNiejNQZjBER2JJQncydUt6bjFYY21PRzJOVUpRTmVoZHlub0hCYzI0bUNXb0VFZVNINGRCOUVETGdYaWpRakRSSlpFU0NUTEdXTXpuNDcybkU3ajU1MFFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMTAwMDI1CWZpbGU6U0hBMjU2U1VNUwl2ZXJzaW9uOjEuMzM4LjAKaVRUU0JDd2Z3WGx0ZUVabFdiaHdQQ1VLQkhiY1FBSVRCVGJLNFBDN3I3Z3pYTnk5VmJWUnJZNGtVRmQ0UVNpSHNMQ3I2bS9BM2ljUHB3aUFvbTNEREE9PQo=";
        expect(parsePublicKey(publicKey).keyId).toBe("CF9B549FC3712F11");
        expect(parseSignature(signature).algorithm).toBe("ED");
        expect(() => verifySignedSums(Buffer.from("abc  ./x\n"), signature, publicKey, "1.338.0")).not.toThrow();
        expect(() => verifySignedSums(Buffer.from("abd  ./x\n"), signature, publicKey, "1.338.0")).toThrow("does not match the file");
    });
});
