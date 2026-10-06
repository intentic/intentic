import { createPublicKey, type KeyObject, sign } from "node:crypto";

// PKCS#10 CSR (RFC 2986), hand-built in DER: node:crypto parses certificates but can't produce a request, and this one
// fixed shape (P-256, no subject, a single dNSName) is small enough to hand-write. No OID encoder, no Name builder, no
// attribute machinery beyond the one extensionRequest this needs.

// Tag+length+content DER encoding; lengths ≥128 use the long form (0x80|byteCount then big-endian count). Preallocated
// rather than built via spread, since `content` here can be a whole SPKI or request body.
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

const lengthBytes = (size: number): Uint8Array => {
    if (size < 0x80) {
        return Uint8Array.from([size]);
    }
    const bytes: number[] = [];
    for (let remaining = size; remaining > 0; remaining = Math.floor(remaining / 256)) {
        bytes.unshift(remaining % 256);
    }
    return Uint8Array.from([0x80 | bytes.length, ...bytes]);
};

const der = (tag: number, content: Uint8Array): Uint8Array => concat(Uint8Array.from([tag]), lengthBytes(content.length), content);

const SEQUENCE = 0x30;
const SET = 0x31;
const OCTET_STRING = 0x04;
const BIT_STRING = 0x03;
// Context-specific constructed [0]: the CertificationRequestInfo attributes slot.
const CONTEXT_0 = 0xa0;
// Context-specific primitive [2]: GeneralName's dNSName choice, an IA5String under the tag.
const DNS_NAME = 0x82;

// INTEGER 0: CertificationRequestInfo's only integer (version v1).
const VERSION_0 = Uint8Array.from([0x02, 0x01, 0x00]);

// The three OIDs this shape needs, as complete DER (tag 0x06 included), so no OID encoder is required.
const OID_EXTENSION_REQUEST = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]); // 1.2.840.113549.1.9.14
const OID_SUBJECT_ALT_NAME = Uint8Array.from([0x06, 0x03, 0x55, 0x1d, 0x11]); // 2.5.29.17
const OID_ECDSA_WITH_SHA256 = Uint8Array.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2

// SAN wrapped as an extensionRequest attribute (Attribute{extensionRequest, SET{SEQUENCE OF Extension}}). Not marked
// critical: every CA here reads a SAN beside an empty subject.
const sanAttributes = (hostnames: readonly string[]): Uint8Array => {
    const generalNames = der(SEQUENCE, concat(...hostnames.map((host) => der(DNS_NAME, new TextEncoder().encode(host)))));
    const extension = der(SEQUENCE, concat(OID_SUBJECT_ALT_NAME, der(OCTET_STRING, generalNames)));
    const attribute = der(SEQUENCE, concat(OID_EXTENSION_REQUEST, der(SET, der(SEQUENCE, extension))));
    return der(CONTEXT_0, attribute);
};

// Public half is lifted straight off `privateKey` as SPKI, so key and request can't disagree. `sign("sha256", ...)` on
// an EC key emits DER-encoded ECDSA (node's default), not the byte-identical-length P1363.
export const buildCsr = (privateKey: KeyObject, hostnames: readonly string[]): Uint8Array => {
    if (hostnames.length === 0) {
        throw new Error("a certificate request needs at least one hostname");
    }
    const spki = new Uint8Array(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
    // Empty subject: the SAN carries the identity; a SAN-only request has no Name.
    const requestInfo = der(SEQUENCE, concat(VERSION_0, der(SEQUENCE, new Uint8Array()), spki, sanAttributes(hostnames)));
    const signature = new Uint8Array(sign("sha256", requestInfo, privateKey));
    return der(
        SEQUENCE,
        concat(
            requestInfo,
            der(SEQUENCE, OID_ECDSA_WITH_SHA256),
            // BIT STRING's leading octet counts unused trailing bits; always 0 for a whole-byte signature.
            der(BIT_STRING, concat(Uint8Array.from([0x00]), signature)),
        ),
    );
};

// ACME carries the CSR base64url-encoded, without padding (RFC 8555 §7.4).
export const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
