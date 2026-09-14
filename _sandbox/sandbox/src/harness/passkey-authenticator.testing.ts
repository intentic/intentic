import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign as signWith } from "node:crypto";
import type { AuthenticationResponse, RegistrationResponse } from "@intentic/sandbox-contract";
import { base64url } from "../auth/webauthn.js";

// A passkey authenticator in software: builds the real attestation and assertion bytes a browser would hand the daemon
// (CBOR, a COSE key, the flag byte, an ES256/RS256/EdDSA signature) so the verifier is tested against the wire format,
// with every knob a test wants to turn wrong. Not part of the build.

export type SoftAlgorithm = -7 | -257 | -8;

export interface SoftAuthenticatorOptions {
    readonly alg?: SoftAlgorithm;
    // What the authenticator claims: a PIN or biometric was checked, and whether the key is synced (backed up).
    readonly userVerified?: boolean;
    readonly backedUp?: boolean;
    // A hardware key counts every signature from 1; a synced passkey reports 0 forever. Default: synced.
    readonly counts?: boolean;
}

export interface CeremonyInput {
    readonly challenge: string;
    readonly origin: string;
    readonly rpId: string;
}

export interface SoftAuthenticator {
    // base64url, what the daemon stores and every assertion names.
    readonly credentialId: string;
    readonly create: (input: CeremonyInput & { readonly clientType?: string; readonly crossOrigin?: boolean }) => RegistrationResponse;
    // `counter` overrides the running count, to replay a lower value than the daemon holds.
    readonly get: (input: CeremonyInput & { readonly counter?: number; readonly userVerified?: boolean }) => AuthenticationResponse;
}

// ---- CBOR encode, the subset an authenticator emits ----

type Encodable = number | string | Uint8Array | Map<number | string, Encodable>;

const head = (major: number, argument: number): Buffer => {
    if (argument < 24) {
        return Buffer.from([(major << 5) | argument]);
    }
    if (argument < 256) {
        return Buffer.from([(major << 5) | 24, argument]);
    }
    if (argument < 65_536) {
        const bytes = Buffer.alloc(3);
        bytes[0] = (major << 5) | 25;
        bytes.writeUInt16BE(argument, 1);
        return bytes;
    }
    const bytes = Buffer.alloc(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(argument, 1);
    return bytes;
};

export const encodeCbor = (value: Encodable): Buffer => {
    if (typeof value === "number") {
        return value >= 0 ? head(0, value) : head(1, -1 - value);
    }
    if (typeof value === "string") {
        const text = Buffer.from(value, "utf8");
        return Buffer.concat([head(3, text.length), text]);
    }
    if (value instanceof Uint8Array) {
        return Buffer.concat([head(2, value.length), Buffer.from(value)]);
    }
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, entry]) => [encodeCbor(key), encodeCbor(entry)])]);
};

// ---- Keys ----

const keyPairFor = (alg: SoftAlgorithm): { publicKey: KeyObject; privateKey: KeyObject } => {
    if (alg === -7) {
        return generateKeyPairSync("ec", { namedCurve: "P-256" });
    }
    if (alg === -257) {
        return generateKeyPairSync("rsa", { modulusLength: 2048 });
    }
    return generateKeyPairSync("ed25519");
};

const jwkBytes = (jwk: Record<string, unknown>, field: string): Buffer => Buffer.from(String(jwk[field]), "base64url");

// The public key as the COSE_Key map the authenticator embeds in attested credential data.
const coseKeyOf = (alg: SoftAlgorithm, publicKey: KeyObject): Map<number, Encodable> => {
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    if (alg === -7) {
        return new Map<number, Encodable>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, jwkBytes(jwk, "x")],
            [-3, jwkBytes(jwk, "y")],
        ]);
    }
    if (alg === -257) {
        return new Map<number, Encodable>([
            [1, 3],
            [3, -257],
            [-1, jwkBytes(jwk, "n")],
            [-2, jwkBytes(jwk, "e")],
        ]);
    }
    return new Map<number, Encodable>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, jwkBytes(jwk, "x")],
    ]);
};

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

const flagsByte = (input: { userVerified: boolean; backedUp: boolean; attested: boolean }): number =>
    0x01 | (input.userVerified ? 0x04 : 0) | (input.backedUp ? 0x08 | 0x10 : 0) | (input.attested ? 0x40 : 0);

const counterBytes = (counter: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(counter);
    return bytes;
};

const clientData = (type: string, challenge: string, origin: string, crossOrigin: boolean): string =>
    base64url.encode(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }), "utf8"));

export const softwareAuthenticator = (options: SoftAuthenticatorOptions = {}): SoftAuthenticator => {
    const alg = options.alg ?? -7;
    const { publicKey, privateKey } = keyPairFor(alg);
    const credentialId = randomBytes(16);
    const userVerified = options.userVerified ?? true;
    const backedUp = options.backedUp ?? false;
    let counter = 0;
    const nextCounter = (): number => {
        if (options.counts === true) {
            counter += 1;
        }
        return counter;
    };
    const id = base64url.encode(credentialId);
    return {
        credentialId: id,
        create: (input) => {
            const attested = Buffer.concat([
                sha256(Buffer.from(input.rpId, "utf8")),
                Buffer.from([flagsByte({ userVerified, backedUp, attested: true })]),
                counterBytes(nextCounter()),
                Buffer.alloc(16),
                Buffer.from([0, credentialId.length]),
                credentialId,
                encodeCbor(coseKeyOf(alg, publicKey)),
            ]);
            const attestationObject = encodeCbor(
                new Map<string, Encodable>([
                    ["fmt", "none"],
                    ["attStmt", new Map()],
                    ["authData", attested],
                ]),
            );
            return {
                id,
                rawId: id,
                type: "public-key",
                response: {
                    clientDataJSON: clientData(input.clientType ?? "webauthn.create", input.challenge, input.origin, input.crossOrigin ?? false),
                    attestationObject: base64url.encode(attestationObject),
                    transports: ["internal"],
                },
            };
        },
        get: (input) => {
            const authData = Buffer.concat([
                sha256(Buffer.from(input.rpId, "utf8")),
                Buffer.from([flagsByte({ userVerified: input.userVerified ?? userVerified, backedUp, attested: false })]),
                counterBytes(input.counter ?? nextCounter()),
            ]);
            const clientDataJSON = clientData("webauthn.get", input.challenge, input.origin, false);
            const signed = Buffer.concat([authData, sha256(base64url.decode(clientDataJSON))]);
            const signature = alg === -8 ? signWith(undefined, signed, privateKey) : signWith("sha256", signed, privateKey);
            return {
                id,
                rawId: id,
                type: "public-key",
                response: { clientDataJSON, authenticatorData: base64url.encode(authData), signature: base64url.encode(signature) },
            };
        },
    };
};
