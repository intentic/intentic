import { createPublicKey, type KeyObject, sign } from "node:crypto";

/* A PKCS#10 certificate request (RFC 2986), in DER, hand-built.
 *
 * ACME's finalize step takes a CSR and nothing else will do, and node:crypto can parse certificates but not
 * produce a request, so this is the one gap between "the daemon holds an EC key" and "a CA will sign it".
 * The alternative was a library that brings 127 transitive packages (several deprecated) into the image the
 * agent runs in; for ONE fixed shape. P-256, no subject, a single dNSName, the ASN.1 is small enough to own,
 * and the platform already hand-writes its Cloudflare client for the same reason.
 *
 * Fixed shape means the encoder can stay minimal on purpose: no OID encoder (the three we need are written out
 * as their DER bytes), no Name builder (the subject is empty, the SAN is what a CA reads, and CA/B Forum
 * deprecated the common name years ago), no attribute machinery beyond the one extensionRequest. Anything this
 * cannot express is something we do not ask for. */

// ——— DER ——————————————————————————————————————————————————————————————————————————————————————————————
// Tag + length + content. Lengths under 128 are one byte; anything longer is the long form (0x80 | byteCount,
// then the count big-endian), which a 256-byte-plus SPKI and the request body both need.
// Preallocated rather than spread: `content` here is a whole SubjectPublicKeyInfo or an entire request body,
// and spreading those into an array literal copies them byte by byte through the JS heap.
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
// Context-specific constructed [0], the CertificationRequestInfo attributes slot.
const CONTEXT_0 = 0xa0;
// Context-specific primitive [2]. GeneralName's dNSName choice, an IA5String under the tag.
const DNS_NAME = 0x82;

// INTEGER 0, the only integer here (CertificationRequestInfo's version, v1).
const VERSION_0 = Uint8Array.from([0x02, 0x01, 0x00]);

// The three OIDs this shape needs, as their complete DER (tag 0x06 included) so no OID encoder is required.
const OID_EXTENSION_REQUEST = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]); // 1.2.840.113549.1.9.14
const OID_SUBJECT_ALT_NAME = Uint8Array.from([0x06, 0x03, 0x55, 0x1d, 0x11]); // 2.5.29.17
const OID_ECDSA_WITH_SHA256 = Uint8Array.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]); // 1.2.840.10045.4.3.2

// ——— The request ——————————————————————————————————————————————————————————————————————————————————————
// subjectAltName as an extensionRequest attribute: Attribute { extensionRequest, SET { SEQUENCE OF Extension } }
// with the one Extension being SAN over a GeneralNames of dNSNames. Not marked critical, a SAN alongside an
// empty subject is understood by every CA we would talk to, and Let's Encrypt reads only this.
const sanAttributes = (hostnames: readonly string[]): Uint8Array => {
    const generalNames = der(SEQUENCE, concat(...hostnames.map((host) => der(DNS_NAME, new TextEncoder().encode(host)))));
    const extension = der(SEQUENCE, concat(OID_SUBJECT_ALT_NAME, der(OCTET_STRING, generalNames)));
    const attribute = der(SEQUENCE, concat(OID_EXTENSION_REQUEST, der(SET, der(SEQUENCE, extension))));
    return der(CONTEXT_0, attribute);
};

/* The DER of a CSR for `hostnames`, signed by `privateKey` (EC P-256).
 *
 * The public half is lifted straight off the private key as SPKI, the same bytes the CA will embed, so the
 * key and the request can never disagree. `sign` with a plain "sha256" over an EC key emits the DER-encoded
 * ECDSA signature that ecdsa-with-SHA256 declares, which is node's default (`dsaEncoding: "der"`); saying so
 * here because the alternative encoding, IEEE P1363, is byte-identical in length and would be silently wrong. */
export const buildCsr = (privateKey: KeyObject, hostnames: readonly string[]): Uint8Array => {
    if (hostnames.length === 0) {
        throw new Error("a certificate request needs at least one hostname");
    }
    const spki = new Uint8Array(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
    // An EMPTY subject: the SAN carries the identity, and a CSR with no Name is what a SAN-only request is.
    const requestInfo = der(SEQUENCE, concat(VERSION_0, der(SEQUENCE, new Uint8Array()), spki, sanAttributes(hostnames)));
    const signature = new Uint8Array(sign("sha256", requestInfo, privateKey));
    return der(
        SEQUENCE,
        concat(
            requestInfo,
            der(SEQUENCE, OID_ECDSA_WITH_SHA256),
            // BIT STRING's leading octet counts unused trailing bits, always 0 for a whole-byte signature.
            der(BIT_STRING, concat(Uint8Array.from([0x00]), signature)),
        ),
    );
};

// ACME carries the CSR base64url-encoded, without padding (RFC 8555 §7.4).
export const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
