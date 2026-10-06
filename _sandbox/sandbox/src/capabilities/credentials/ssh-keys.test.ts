import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { generateSshKey, keyComment, publicKeyOf } from "./ssh-keys.js";

// The key a person never sees has to be one OpenSSH reads: written by hand in its own container, so the layout is
// pinned here field by field, and the halves are proven to belong together by signing with one and verifying with the
// other. ssh-keys.integration.test.ts has the real ssh-keygen read it.

// An independent reading of the one layout generateSshKey writes, as the oracle for it.
const decode = (privateKey: string) => {
    const lines = privateKey.trimEnd().split("\n");
    const body = Buffer.from(lines.slice(1, -1).join(""), "base64");
    let at = 15;
    const next = (): Buffer => {
        const length = body.readUInt32BE(at);
        at += 4 + length;
        return body.subarray(at - length, at);
    };
    const [magic, cipher, kdf, kdfOptions] = [body.subarray(0, 15).toString("latin1"), next(), next(), next()];
    const count = body.readUInt32BE(at);
    at += 4;
    const blob = next();
    const section = next();
    at = 0;
    const read = (): Buffer => {
        const length = section.readUInt32BE(at);
        at += 4 + length;
        return section.subarray(at - length, at);
    };
    const [checkA, checkB] = [section.readUInt32BE(0), section.readUInt32BE(4)];
    at = 8;
    const [type, point, secret, comment] = [read(), read(), read(), read()];
    return {
        lines,
        magic,
        cipher,
        kdf,
        kdfOptions,
        count,
        blob,
        section,
        checkA,
        checkB,
        type,
        point,
        secret,
        comment,
        padding: section.subarray(at),
    };
};

test("writes one unencrypted ed25519 key in OpenSSH's container, armored and wrapped as ssh-keygen writes it", () => {
    const pair = generateSshKey("intentic-box");
    const key = decode(pair.privateKey);

    expect(key.lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(key.lines.at(-1)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(pair.privateKey.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    // Every body line but the last is exactly 70 columns.
    expect(key.lines.slice(1, -2).every((line) => line.length === 70)).toBe(true);
    expect(key.magic).toBe("openssh-key-v1\0");
    expect([key.cipher.toString(), key.kdf.toString(), key.kdfOptions.length, key.count]).toEqual(["none", "none", 0, 1]);
    // The check words match, which is all an unencrypted key asks of them.
    expect(key.checkA).toBe(key.checkB);
    expect(key.type.toString()).toBe("ssh-ed25519");
    expect(key.point.length).toBe(32);
    // OpenSSH's private half is the seed followed by the public point.
    expect(key.secret.length).toBe(64);
    expect(key.secret.subarray(32).equals(key.point)).toBe(true);
    expect(key.comment.toString()).toBe("intentic-box");
    // Padded 1, 2, 3… to a whole number of 8-byte blocks.
    expect(key.section.length % 8).toBe(0);
    expect([...key.padding]).toEqual(Array.from({ length: key.padding.length }, (_, index) => index + 1));
});

test("the public line and the private key are halves of one key", () => {
    const pair = generateSshKey("intentic-box");
    const key = decode(pair.privateKey);
    const [type, blob, comment] = pair.publicKey.split(" ");
    expect([type, comment]).toEqual(["ssh-ed25519", "intentic-box"]);
    // The header's copy of the public key is the line's, byte for byte.
    expect(Buffer.from(blob ?? "", "base64").equals(key.blob)).toBe(true);

    const signer = createPrivateKey({
        key: { kty: "OKP", crv: "Ed25519", d: key.secret.subarray(0, 32).toString("base64url"), x: key.point.toString("base64url") },
        format: "jwk",
    });
    const checker = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.blob.subarray(-32).toString("base64url") }, format: "jwk" });
    const message = Buffer.from("intentic");
    expect(verify(null, message, checker, sign(null, message, signer))).toBe(true);
});

test("every key is a new one", () => {
    const [first, second] = [generateSshKey("c"), generateSshKey("c")];
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.privateKey).not.toBe(second.privateKey);
});

test("reads the public line back off a private key, as pasted from any editor", () => {
    const pair = generateSshKey("intentic-box");
    expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
    // Windows line endings and stray indentation, the way keys arrive in a form.
    expect(publicKeyOf(`  ${pair.privateKey.replaceAll("\n", "\r\n    ")}`)).toBe(pair.publicKey);
});

test("reads no public line off anything that is not an OpenSSH private key", () => {
    const pair = generateSshKey("c");
    expect(publicKeyOf("__intentic_vaulted__")).toBeUndefined();
    expect(publicKeyOf("")).toBeUndefined();
    expect(publicKeyOf("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n")).toBeUndefined();
    expect(publicKeyOf("-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----\n")).toBeUndefined();
    // Cut off inside the header: the reader stops at the end rather than reading past it.
    const lines = pair.privateKey.split("\n");
    expect(publicKeyOf([lines[0], lines[1]?.slice(0, 40), lines.at(-2)].join("\n"))).toBeUndefined();
});

test("names the sandbox in the comment, in characters that cannot break out of a quoted shell word", () => {
    expect(keyComment("")).toBe("intentic");
    expect(keyComment("   ")).toBe("intentic");
    expect(keyComment("prod")).toBe("intentic-prod");
    expect(keyComment("ops.team_1")).toBe("intentic-ops.team_1");
    expect(keyComment("Ada's box")).toBe("intentic-Ada-s-box");
    expect(keyComment("'; rm -rf ~ #")).toBe("intentic-rm-rf");
});
