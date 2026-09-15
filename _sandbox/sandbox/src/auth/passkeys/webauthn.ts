import { createHash, createPublicKey, type KeyObject, verify as verifyWithKey } from "node:crypto";
import type { AuthenticationResponse, RegistrationResponse } from "@intentic/sandbox-contract";
import { tokenEquals } from "../auth.js";

// The relying-party half of WebAuthn, as narrow as passkeys let it be: attestation is not judged (a passkey's
// provenance is nothing this sandbox has a policy about), user verification is always required, and the three
// algorithms passkey authenticators sign with (ES256, RS256, EdDSA) are verified by node:crypto. What lives here is
// the byte layout the spec puts around a signature, and nothing that layout does not force.

export const base64url = {
    encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url"),
    decode: (text: string): Buffer => Buffer.from(text, "base64url"),
};

// COSE algorithm identifiers: offered to the browser in this order, and the only ones a registration is accepted with.
export const ACCEPTED_ALGORITHMS = [-7, -257, -8] as const;
export type CoseAlgorithm = (typeof ACCEPTED_ALGORITHMS)[number];

// A credential's public key as stored: node's own JWK import format, so verification is one createPublicKey away.
export interface StoredPublicKey {
    readonly alg: CoseAlgorithm;
    readonly jwk: Readonly<Record<string, string>>;
}

// Thrown for every way a response can fail to be what the ceremony asked for; the routes answer 400 with the message.
export class WebAuthnError extends Error {}

// ---- CBOR (RFC 8949), the definite-length subset authenticators emit ----

type CborValue = number | string | Uint8Array | boolean | undefined | CborValue[] | Map<CborValue, CborValue>;

class CborReader {
    offset = 0;
    constructor(private readonly bytes: Uint8Array) {}

    private take(count: number): Uint8Array {
        if (this.offset + count > this.bytes.length) {
            throw new WebAuthnError("CBOR ends mid-item");
        }
        const slice = this.bytes.subarray(this.offset, this.offset + count);
        this.offset += count;
        return slice;
    }

    // The argument after the initial byte; 8-byte arguments past 2^53 have no place in a credential and are refused.
    private argument(info: number): number {
        if (info < 24) {
            return info;
        }
        if (info > 27) {
            throw new WebAuthnError("indefinite-length CBOR is not accepted");
        }
        const width = 2 ** (info - 24);
        const view = this.take(width);
        let value = 0;
        for (const byte of view) {
            value = value * 256 + byte;
        }
        if (!Number.isSafeInteger(value)) {
            throw new WebAuthnError("CBOR integer too large");
        }
        return value;
    }

    // Major type 7: the two booleans and the two nothings; floats have no place in a credential.
    private simple(info: number): CborValue {
        if (info === 20 || info === 21) {
            return info === 21;
        }
        if (info === 22 || info === 23) {
            return undefined;
        }
        throw new WebAuthnError("CBOR floats and reserved simple values are not accepted");
    }

    private map(length: number): Map<CborValue, CborValue> {
        const map = new Map<CborValue, CborValue>();
        for (let index = 0; index < length; index += 1) {
            const key = this.read();
            map.set(key, this.read());
        }
        return map;
    }

    // Major types 0-5, once the argument is known: an integer, bytes, text, an array or a map.
    private item(major: number, argument: number): CborValue {
        switch (major) {
            case 0:
                return argument;
            case 1:
                return -1 - argument;
            case 2:
                return this.take(argument);
            case 3:
                return Buffer.from(this.take(argument)).toString("utf8");
            case 4:
                return Array.from({ length: argument }, () => this.read());
            default:
                return this.map(argument);
        }
    }

    read(): CborValue {
        const [initial] = this.take(1);
        const major = (initial ?? 0) >> 5;
        const info = (initial ?? 0) & 0x1f;
        if (major === 7) {
            return this.simple(info);
        }
        if (major === 6) {
            // A tag decorates the item after it; nothing here is tagged with intent, so the tag is dropped.
            this.argument(info);
            return this.read();
        }
        return this.item(major, this.argument(info));
    }
}

// The first CBOR item in `bytes` and how many bytes it spanned, so a caller can find what follows it (authData holds a
// COSE key followed by optional extensions).
export const decodeCbor = (bytes: Uint8Array): { readonly value: CborValue; readonly length: number } => {
    const reader = new CborReader(bytes);
    const value = reader.read();
    return { value, length: reader.offset };
};

// ---- Authenticator data ----

export interface AuthenticatorFlags {
    readonly userPresent: boolean;
    readonly userVerified: boolean;
    readonly backupEligible: boolean;
    readonly backedUp: boolean;
    readonly attestedCredential: boolean;
    readonly extensions: boolean;
}

export interface AuthenticatorData {
    readonly rpIdHash: Buffer;
    readonly flags: AuthenticatorFlags;
    readonly counter: number;
    // Present on registration (the AT flag): the credential the authenticator just made and the key it will sign with.
    readonly credential?: { readonly aaguid: Buffer; readonly id: Buffer; readonly publicKey: StoredPublicKey };
}

const bytesAt = (map: Map<CborValue, CborValue>, key: number, what: string): Buffer => {
    const value = map.get(key);
    if (!(value instanceof Uint8Array)) {
        throw new WebAuthnError(`COSE key has no ${what}`);
    }
    return Buffer.from(value);
};

// COSE_Key → the JWK node imports. kty 2 is EC2 (P-256 only), kty 3 RSA, kty 1 OKP (Ed25519 only): the shapes the
// accepted algorithms take, and nothing else is admitted however well-formed.
const publicKeyOf = (cose: CborValue): StoredPublicKey => {
    if (!(cose instanceof Map)) {
        throw new WebAuthnError("credential public key is not a COSE key");
    }
    const kty = cose.get(1);
    const alg = cose.get(3);
    if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
        return { alg, jwk: { kty: "EC", crv: "P-256", x: base64url.encode(bytesAt(cose, -2, "x")), y: base64url.encode(bytesAt(cose, -3, "y")) } };
    }
    if (kty === 3 && alg === -257) {
        return { alg, jwk: { kty: "RSA", n: base64url.encode(bytesAt(cose, -1, "modulus")), e: base64url.encode(bytesAt(cose, -2, "exponent")) } };
    }
    if (kty === 1 && alg === -8 && cose.get(-1) === 6) {
        return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: base64url.encode(bytesAt(cose, -2, "x")) } };
    }
    throw new WebAuthnError("credential uses a key type or algorithm this sandbox does not accept");
};

export const parseAuthenticatorData = (authData: Buffer): AuthenticatorData => {
    // rpIdHash (32) + flags (1) + counter (4) is the fixed head every response carries.
    if (authData.length < 37) {
        throw new WebAuthnError("authenticator data too short");
    }
    const flagByte = authData[32] ?? 0;
    const flags: AuthenticatorFlags = {
        userPresent: (flagByte & 0x01) !== 0,
        userVerified: (flagByte & 0x04) !== 0,
        backupEligible: (flagByte & 0x08) !== 0,
        backedUp: (flagByte & 0x10) !== 0,
        attestedCredential: (flagByte & 0x40) !== 0,
        extensions: (flagByte & 0x80) !== 0,
    };
    const head = { rpIdHash: authData.subarray(0, 32), flags, counter: authData.readUInt32BE(33) };
    if (!flags.attestedCredential) {
        return head;
    }
    // aaguid (16) + credential id length (2) + id + COSE key.
    if (authData.length < 55) {
        throw new WebAuthnError("attested credential data too short");
    }
    const idLength = authData.readUInt16BE(53);
    const idEnd = 55 + idLength;
    if (idLength === 0 || idLength > 1023 || authData.length <= idEnd) {
        throw new WebAuthnError("credential id length out of range");
    }
    const cose = decodeCbor(authData.subarray(idEnd));
    return {
        ...head,
        credential: { aaguid: authData.subarray(37, 53), id: authData.subarray(55, idEnd), publicKey: publicKeyOf(cose.value) },
    };
};

// ---- The two ceremonies' checks ----

export interface CeremonyExpectation {
    // base64url, exactly as it was handed to the browser.
    readonly challenge: string;
    readonly origin: string;
    readonly rpId: string;
}

// The browser's own statement of what it signed: the ceremony kind, the challenge it was handed, the origin it ran on.
// `crossOrigin` refuses a ceremony run in an iframe on another site.
const checkClientData = (encoded: string, type: "webauthn.create" | "webauthn.get", expected: CeremonyExpectation): void => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(base64url.decode(encoded).toString("utf8"));
    } catch {
        throw new WebAuthnError("client data is not JSON");
    }
    const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    if (data["type"] !== type) {
        throw new WebAuthnError(`client data is for ${String(data["type"])}, expected ${type}`);
    }
    if (typeof data["challenge"] !== "string" || !tokenEquals(data["challenge"], expected.challenge)) {
        throw new WebAuthnError("challenge does not match the one this sandbox issued");
    }
    if (data["origin"] !== expected.origin) {
        throw new WebAuthnError(`ceremony ran on ${String(data["origin"])}, expected ${expected.origin}`);
    }
    if (data["crossOrigin"] === true) {
        throw new WebAuthnError("cross-origin ceremonies are not accepted");
    }
};

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

// rpIdHash names the site the authenticator scoped the credential to; UP and UV are what makes a passkey a second
// factor rather than a bearer token in a chip.
const checkRelyingParty = (authData: AuthenticatorData, rpId: string): void => {
    if (!authData.rpIdHash.equals(sha256(Buffer.from(rpId, "utf8")))) {
        throw new WebAuthnError(`credential is scoped to another site, expected ${rpId}`);
    }
    if (!authData.flags.userPresent) {
        throw new WebAuthnError("authenticator did not confirm user presence");
    }
    if (!authData.flags.userVerified) {
        throw new WebAuthnError("authenticator did not verify the user (PIN or biometric required)");
    }
};

export interface VerifiedRegistration {
    // base64url, the id every later assertion names.
    readonly credentialId: string;
    readonly publicKey: StoredPublicKey;
    readonly counter: number;
    readonly backedUp: boolean;
    readonly aaguid: string;
    readonly transports: readonly string[];
}

export const verifyRegistration = (response: RegistrationResponse, expected: CeremonyExpectation): VerifiedRegistration => {
    checkClientData(response.response.clientDataJSON, "webauthn.create", expected);
    const attestation = decodeCbor(base64url.decode(response.response.attestationObject)).value;
    const authDataBytes = attestation instanceof Map ? attestation.get("authData") : undefined;
    if (!(authDataBytes instanceof Uint8Array)) {
        throw new WebAuthnError("attestation object carries no authenticator data");
    }
    const authData = parseAuthenticatorData(Buffer.from(authDataBytes));
    checkRelyingParty(authData, expected.rpId);
    if (authData.credential === undefined) {
        throw new WebAuthnError("registration carries no credential");
    }
    if (!base64url.decode(response.id).equals(authData.credential.id) || !base64url.decode(response.rawId).equals(authData.credential.id)) {
        throw new WebAuthnError("credential id does not match the attested credential");
    }
    if (!ACCEPTED_ALGORITHMS.includes(authData.credential.publicKey.alg)) {
        throw new WebAuthnError("credential algorithm not accepted");
    }
    return {
        credentialId: base64url.encode(authData.credential.id),
        publicKey: authData.credential.publicKey,
        counter: authData.counter,
        backedUp: authData.flags.backedUp,
        aaguid: authData.credential.aaguid.toString("hex"),
        transports: response.response.transports ?? [],
    };
};

export interface AuthenticationExpectation extends CeremonyExpectation {
    readonly publicKey: StoredPublicKey;
    // The counter the credential last reported; an authenticator that counts must count up.
    readonly counter: number;
}

export interface VerifiedAuthentication {
    readonly counter: number;
    readonly backedUp: boolean;
}

const keyObjectOf = (stored: StoredPublicKey): KeyObject => createPublicKey({ key: stored.jwk, format: "jwk" });

// ES256 signatures arrive DER-encoded and RS256 is PKCS#1 v1.5, node's defaults for those keys; EdDSA takes no digest.
const signatureValid = (stored: StoredPublicKey, signed: Buffer, signature: Buffer): boolean => {
    try {
        return stored.alg === -8 ? verifyWithKey(undefined, signed, keyObjectOf(stored), signature) : verifyWithKey("sha256", signed, keyObjectOf(stored), signature);
    } catch {
        return false;
    }
};

export const verifyAuthentication = (response: AuthenticationResponse, expected: AuthenticationExpectation): VerifiedAuthentication => {
    checkClientData(response.response.clientDataJSON, "webauthn.get", expected);
    const authDataBytes = base64url.decode(response.response.authenticatorData);
    const authData = parseAuthenticatorData(authDataBytes);
    checkRelyingParty(authData, expected.rpId);
    const signed = Buffer.concat([authDataBytes, sha256(base64url.decode(response.response.clientDataJSON))]);
    if (!signatureValid(expected.publicKey, signed, base64url.decode(response.response.signature))) {
        throw new WebAuthnError("signature does not verify against the registered key");
    }
    // A synced passkey reports 0 forever and is exempt; one that has ever counted must keep counting up, or a clone
    // is answering.
    if ((authData.counter > 0 || expected.counter > 0) && authData.counter <= expected.counter) {
        throw new WebAuthnError("signature counter did not advance");
    }
    return { counter: authData.counter, backedUp: authData.flags.backedUp };
};
