import { verify } from "node:crypto";

// Whether `signature` is the pinned Windows Hello key's over `challenge`: KeyCredential signs with RSASSA-PKCS1-v1_5
// and SHA-256, and hands its public key over as X.509 SubjectPublicKeyInfo, which node:crypto reads as is. This is how
// the protected service knows a yes came from a person's Hello gesture and not from a program of the user standing in
// for the session helper: only the TPM-held key, with a gesture, makes this signature.
export const helloSigned = (publicKeySpki: string, challenge: string, signature: string): boolean => {
    try {
        return verify("sha256", Buffer.from(challenge, "base64url"), { key: Buffer.from(publicKeySpki, "base64"), format: "der", type: "spki" }, Buffer.from(signature, "base64"));
    } catch {
        // allow(silent-catch): a key or signature that does not parse proves nothing, which is the answer
        return false;
    }
};
