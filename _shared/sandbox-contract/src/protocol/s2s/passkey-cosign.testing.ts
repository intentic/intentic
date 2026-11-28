import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign as signWith } from "node:crypto";
import { cosignChallenge, type PasskeyCosign, type PasskeyCosignChallenge } from "./passkey-cosign.js";

// A passkey in software, for the co-signature's tests: the assertion bytes a browser hands back (the authenticator data
// with its flag byte, clientDataJSON, a DER ES256, an RS256 or an EdDSA signature), with the knobs a test turns wrong.
// The approach of the daemon's harness (_sandbox/sandbox/src/harness/passkey-authenticator.testing.ts), which the
// contract cannot import; only the assertion half, since a co-signature carries the key the sandbox already stored.
// Not part of the build.

export type SoftPasskeyAlg = -7 | -8 | -257;

export interface SoftAssertion {
    readonly rpId: string;
    readonly challenge: string;
    readonly type?: string;
    readonly userPresent?: boolean;
    readonly userVerified?: boolean;
    // The rpId the authenticator data is scoped to, when it should differ from the one claimed.
    readonly scopedTo?: string;
}

export interface SoftPasskey {
    readonly credentialId: string;
    readonly publicKey: PasskeyCosign["publicKey"];
    readonly assert: (input: SoftAssertion) => Pick<PasskeyCosign, "authenticatorData" | "clientDataJSON" | "signature">;
}

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

const keyPairFor = (alg: SoftPasskeyAlg): { publicKey: KeyObject; privateKey: KeyObject } => {
    if (alg === -7) {
        return generateKeyPairSync("ec", { namedCurve: "P-256" });
    }
    if (alg === -257) {
        return generateKeyPairSync("rsa", { modulusLength: 2048 });
    }
    return generateKeyPairSync("ed25519");
};

// The key as the sandbox stores it: node's JWK, only the members each algorithm's key has.
const jwkOf = (alg: SoftPasskeyAlg, publicKey: KeyObject) => {
    const { kty = "", crv = "", x = "", y = "", n = "", e = "" } = publicKey.export({ format: "jwk" });
    if (alg === -7) {
        return { kty, crv, x, y };
    }
    return alg === -257 ? { kty, n, e } : { kty, crv, x };
};

export const softPasskey = (alg: SoftPasskeyAlg = -7): SoftPasskey => {
    const { publicKey, privateKey } = keyPairFor(alg);
    return {
        credentialId: randomBytes(16).toString("base64url"),
        publicKey: { alg, jwk: jwkOf(alg, publicKey) },
        assert: (input) => {
            const flags = (input.userPresent === false ? 0 : 0x01) | (input.userVerified === false ? 0 : 0x04);
            const authData = Buffer.concat([sha256(Buffer.from(input.scopedTo ?? input.rpId, "utf8")), Buffer.from([flags]), Buffer.alloc(4)]);
            const clientData = Buffer.from(
                JSON.stringify({ type: input.type ?? "webauthn.get", challenge: input.challenge, origin: `https://${input.rpId}`, crossOrigin: false }),
                "utf8",
            );
            const signed = Buffer.concat([authData, sha256(clientData)]);
            const signature = alg === -8 ? signWith(undefined, signed, privateKey) : signWith("sha256", signed, privateKey);
            return {
                authenticatorData: authData.toString("base64url"),
                clientDataJSON: clientData.toString("base64url"),
                signature: signature.toString("base64url"),
            };
        },
    };
};

// A whole co-signature by `passkey` over `challenge`, as the daemon records it; `assertion` turns a knob wrong.
export const softCosign = (
    passkey: SoftPasskey,
    challenge: PasskeyCosignChallenge,
    rpId = "sbx-1.intentic.app",
    assertion: Partial<SoftAssertion> = {},
): PasskeyCosign => ({
    v: 1,
    challenge,
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    rpId,
    ...passkey.assert({ rpId, challenge: cosignChallenge(challenge), ...assertion }),
    label: "Laptop",
});
