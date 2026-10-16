import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";

// MINISIGN, VERIFIED WITH NODE'S OWN Ed25519. The release key is the desktop updater's (tauri.conf.json `pubkey`), a
// minisign key, and since the first signed release it also signs the release's SHA256SUMS (SHA256SUMS.sig), which is
// what an agent checks before it replaces itself or ic. No minisign binary and no dependency: a signature is Ed25519
// over the file (the legacy `Ed` algorithm) or over its BLAKE2b-512 (the prehashed `ED` one, which Tauri's signer
// writes), plus a second Ed25519 signature over the first and the trusted comment.
//
// This module imports nothing but node:crypto, deliberately: the release script (release-checksums.mjs) imports it as
// it is, with Node stripping the types, to check the signature it just made the way every agent will.

/** A minisign Ed25519 public key. `keyId` is spelled as minisign prints it: the eight id bytes, little-endian, in hex. */
export interface MinisignPublicKey {
    readonly keyId: string;
    readonly key: KeyObject;
}

/** A minisign signature file, taken apart. */
export interface MinisignSignature {
    readonly algorithm: "Ed" | "ED";
    readonly keyId: string;
    readonly signature: Buffer;
    readonly trustedComment: string;
    readonly globalSignature: Buffer;
}

const UNTRUSTED = "untrusted comment:";
const TRUSTED = "trusted comment: ";

// Tauri keeps both files whole in base64 (the config's `pubkey`, every `.sig` it writes), minisign keeps them as text.
// Either is read: base64 that decodes to a minisign file is that file.
const minisignLines = (text: string): string[] => {
    const trimmed = text.trim();
    if (!trimmed.startsWith(UNTRUSTED) && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
        const decoded = Buffer.from(trimmed, "base64").toString("utf8");
        if (decoded.startsWith(UNTRUSTED)) {
            return decoded.trim().split(/\r?\n/);
        }
    }
    return trimmed.split(/\r?\n/);
};

const keyIdOf = (bytes: Uint8Array): string =>
    Buffer.from([...bytes].toReversed())
        .toString("hex")
        .toUpperCase();

/** A minisign public key: its file (comment line and key line), Tauri's base64 of that file, or the key line alone. */
export const parsePublicKey = (text: string): MinisignPublicKey => {
    const keyLine = minisignLines(text).find((line) => line.trim() !== "" && !line.startsWith(UNTRUSTED)) ?? "";
    const raw = Buffer.from(keyLine.trim(), "base64");
    if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") {
        throw new Error("not a minisign Ed25519 public key");
    }
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") }, format: "jwk" });
    return { keyId: keyIdOf(raw.subarray(2, 10)), key };
};

/** A minisign signature: its four lines as minisign writes them, or Tauri's base64 of them. */
export const parseSignature = (text: string): MinisignSignature => {
    const [untrusted, signatureLine, trusted, globalLine] = minisignLines(text);
    if (
        untrusted?.startsWith(UNTRUSTED) !== true ||
        trusted?.startsWith(TRUSTED) !== true ||
        signatureLine === undefined ||
        globalLine === undefined
    ) {
        throw new Error("not a minisign signature: it needs an untrusted comment, a signature, a trusted comment and a global signature");
    }
    const raw = Buffer.from(signatureLine.trim(), "base64");
    const algorithm = raw.toString("latin1", 0, 2);
    if (raw.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED")) {
        throw new Error(`not a minisign Ed25519 signature (algorithm "${algorithm}", ${raw.length} bytes)`);
    }
    const globalSignature = Buffer.from(globalLine.trim(), "base64");
    if (globalSignature.length !== 64) {
        throw new Error(`the global signature is ${globalSignature.length} bytes, not 64`);
    }
    return {
        algorithm,
        keyId: keyIdOf(raw.subarray(2, 10)),
        signature: raw.subarray(10),
        trustedComment: trusted.slice(TRUSTED.length),
        globalSignature,
    };
};

/**
 * Throws, saying what failed, unless `signature` is `publicKey`'s over `data` and over its own trusted comment. Answers
 * the trusted comment, which only now can be believed.
 */
export const verifyMinisign = (data: Uint8Array, signature: MinisignSignature, publicKey: MinisignPublicKey): string => {
    if (signature.keyId !== publicKey.keyId) {
        throw new Error(`it is signed by key ${signature.keyId}, not the release key ${publicKey.keyId}`);
    }
    const signed = signature.algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    if (!verify(null, signed, publicKey.key, signature.signature)) {
        throw new Error("the signature does not match the file");
    }
    const comment = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
    if (!verify(null, comment, publicKey.key, signature.globalSignature)) {
        throw new Error("the signature over the trusted comment does not match");
    }
    return signature.trustedComment;
};

// `timestamp:1792100025<TAB>file:SHA256SUMS<TAB>version:1.338.0`, as Tauri's signer writes it with --app-version.
const commentFields = (comment: string): Map<string, string> =>
    new Map(
        comment.split("\t").map((field) => {
            const colon = field.indexOf(":");
            return colon === -1 ? [field, ""] : [field.slice(0, colon), field.slice(colon + 1)];
        }),
    );

/**
 * What a release's SHA256SUMS.sig must be, checked by every agent before it trusts the sums and by the release before it
 * publishes them: the release key's signature over exactly these bytes, whose trusted comment names SHA256SUMS and this
 * version. The version is what stops an older release's signed sums (and its older binaries) from answering for a newer
 * one. Throws, saying which, otherwise.
 */
export const verifySignedSums = (sums: Uint8Array, signatureText: string, publicKeyText: string, version: string): void => {
    const fields = commentFields(verifyMinisign(sums, parseSignature(signatureText), parsePublicKey(publicKeyText)));
    if (fields.get("file") !== "SHA256SUMS") {
        throw new Error(`the signature is for ${fields.get("file") ?? "a file it does not name"}, not SHA256SUMS`);
    }
    if (fields.get("version") !== version) {
        throw new Error(`the signature is for release ${fields.get("version") ?? "(none named)"}, not ${version}`);
    }
};
