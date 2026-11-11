import { generateKeyPair, type KeyObject, sign } from "node:crypto";
import { promisify } from "node:util";
import { KEY_REQUEST_ATTRIBUTES, type KeyRequestAttribute } from "@intentic/extension-manifest";

// A key the sandbox makes for a card whose service issues a certificate from a request (e-Doręczenia's system
// registration), so the person setting it up only ever handles the request. RSA 2048 and SHA-256, the pair the
// e-Doręczenia instructions generate with `openssl req -newkey rsa:2048`. PKCS#10 (RFC 2986) is written here in DER by
// hand: node:crypto signs and exports keys but writes no request, and the request must exist before any file does.

export interface CertificateRequest {
    // The request, armored as `openssl req` writes it.
    readonly request: string;
    // Its subject as one line (`C=PL, O=…, CN=…`), so the form shows what the issuer will read.
    readonly subject: string;
    // PKCS#8, unencrypted and armored: what the card's private key field holds once saved.
    readonly privateKey: string;
}

// A subject the request cannot carry, in words for the person filling the card in.
export class CertificateRequestRefusal extends Error {}

const makePair = promisify(generateKeyPair);

const OIDS = {
    C: "2.5.4.6",
    ST: "2.5.4.8",
    L: "2.5.4.7",
    O: "2.5.4.10",
    OU: "2.5.4.11",
    CN: "2.5.4.3",
    emailAddress: "1.2.840.113549.1.9.1",
} as const satisfies Record<KeyRequestAttribute, string>;
// X.520's upper bounds, which issuers enforce; a country is its two-letter code.
const MAX_LENGTH = { C: 2, ST: 128, L: 128, O: 64, OU: 64, CN: 64, emailAddress: 255 } as const satisfies Record<KeyRequestAttribute, number>;
const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

// DER (X.690): a tag, its length (short form under 128, else the count of length bytes then the bytes), its content.
const der = (tag: number, content: Buffer): Buffer => {
    const length = content.length;
    if (length < 0x80) {
        return Buffer.concat([Buffer.from([tag, length]), content]);
    }
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
        bytes.unshift(rest % 256);
    }
    return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
};
const sequence = (...items: Buffer[]): Buffer => der(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => der(0x31, Buffer.concat(items));
const objectId = (dotted: string): Buffer => {
    const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
    const bytes = [40 * first + second];
    for (const arc of rest) {
        const groups: number[] = [];
        for (let value = arc; ; value = Math.floor(value / 128)) {
            groups.unshift((value % 128) | (groups.length === 0 ? 0 : 0x80));
            if (value < 128) {
                break;
            }
        }
        bytes.push(...groups);
    }
    return der(0x06, Buffer.from(bytes));
};
// A country is a PrintableString and an e-mail address an IA5String, as RFC 5280 has them; the rest UTF8String.
const attributeValue = (attribute: KeyRequestAttribute, value: string): Buffer =>
    der(attribute === "C" ? 0x13 : attribute === "emailAddress" ? 0x16 : 0x0c, Buffer.from(value, "utf8"));

// Letters a decomposition cannot reach, written as their base letters (Polish ł above all).
const UNDECOMPOSED = new Map([
    ["ł", "l"],
    ["Ł", "L"],
    ["đ", "d"],
    ["Đ", "D"],
    ["ø", "o"],
    ["Ø", "O"],
    ["ß", "ss"],
    ["æ", "ae"],
    ["Æ", "AE"],
    ["œ", "oe"],
    ["Œ", "OE"],
]);

// ASCII, since issuers that refuse anything else are common (e-Doręczenia asks for no Polish letters): diacritics folded
// to their base letters, and anything that is still not printable ASCII refused by name.
const asciiValue = (attribute: KeyRequestAttribute, raw: string): string => {
    const value = raw
        .trim()
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .replace(/[łŁđĐøØßæÆœŒ]/gu, (letter) => UNDECOMPOSED.get(letter) ?? letter);
    if (!/^[\x20-\x7E]*$/u.test(value)) {
        throw new CertificateRequestRefusal(`${attribute} holds a character a certificate request cannot carry: use plain letters, digits and punctuation`);
    }
    if (attribute === "C" && value !== "" && !/^[A-Za-z]{2}$/u.test(value)) {
        throw new CertificateRequestRefusal(`C is a country's two-letter code (PL), not "${value}"`);
    }
    if (value.length > MAX_LENGTH[attribute]) {
        throw new CertificateRequestRefusal(`${attribute} is ${value.length} characters long, past the ${MAX_LENGTH[attribute]} an issuer accepts`);
    }
    return attribute === "C" ? value.toUpperCase() : value;
};

// The subject in the order a request writes it, empty attributes left out; at least a common name or an organization.
const subjectOf = (given: Partial<Readonly<Record<KeyRequestAttribute, string>>>): [KeyRequestAttribute, string][] => {
    const subject = KEY_REQUEST_ATTRIBUTES.flatMap((attribute): [KeyRequestAttribute, string][] => {
        const value = asciiValue(attribute, given[attribute] ?? "");
        return value === "" ? [] : [[attribute, value]];
    });
    if (!subject.some(([attribute]) => attribute === "CN" || attribute === "O")) {
        throw new CertificateRequestRefusal("the request needs at least a common name (CN) or an organization (O) to say whose it is");
    }
    return subject;
};

const armored = (label: string, bytes: Buffer): string =>
    `-----BEGIN ${label}-----\n${(bytes.toString("base64").match(/.{1,64}/gu) ?? []).join("\n")}\n-----END ${label}-----\n`;

// CertificationRequestInfo: version 0, the subject, the public key, and no attributes (the instructions leave the
// challenge password and company name empty).
const requestInfo = (subject: readonly [KeyRequestAttribute, string][], publicKey: KeyObject): Buffer =>
    sequence(
        der(0x02, Buffer.from([0])),
        sequence(...subject.map(([attribute, value]) => set(sequence(objectId(OIDS[attribute]), attributeValue(attribute, value))))),
        publicKey.export({ type: "spki", format: "der" }),
        der(0xa0, Buffer.alloc(0)),
    );

export const makeCertificateRequest = async (given: Partial<Readonly<Record<KeyRequestAttribute, string>>>): Promise<CertificateRequest> => {
    const subject = subjectOf(given);
    const pair = await makePair("rsa", { modulusLength: 2048 });
    const info = requestInfo(subject, pair.publicKey);
    const algorithm = sequence(objectId(SHA256_WITH_RSA), der(0x05, Buffer.alloc(0)));
    const signature = der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", info, pair.privateKey)]));
    return {
        request: armored("CERTIFICATE REQUEST", sequence(info, algorithm, signature)),
        subject: subject.map(([attribute, value]) => `${attribute}=${value}`).join(", "),
        privateKey: String(pair.privateKey.export({ type: "pkcs8", format: "pem" })),
    };
};
