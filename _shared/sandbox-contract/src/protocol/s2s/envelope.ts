import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { S2S_INFO, type S2sPublicKeys, type S2sSigningKeys } from "../../schemas/s2s-identity.js";
import {
    S2S_BODY_MAX_BYTES,
    type S2sEnvelope,
    type S2sEnvelopeHeader,
    type S2sPayload,
    S2sPayloadSchema,
} from "../../schemas/s2s-wire.js";
import { canonicalBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./canonical.js";
import { decapsulate, deriveKey, encapsulate } from "./kem.js";
import { fingerprintOf, type RandomBytes, type S2sKeySet, secretKeysOf } from "./keys.js";
import { hybridSign, hybridVerify } from "./sign.js";

// THE ENVELOPE (docs/architecture/messages.md, "Messages"): a payload sealed to the receiver's key set and signed by the
// sender's. The body is the payload's JSON under AES-256-GCM, its key HKDF-SHA256(mlkem_ss ‖ x25519_ss, salt =
// SHA-256(canonical {header, key agreement}), info = "intentic-s2s/1"), the canonical header its associated data; the hybrid signature is
// over the canonical envelope without `sig`, so the header, `enc` and `body` all. The platform in between sees who talks
// to whom and when, never what.

// A UUIDv7 (RFC 9562): the time in milliseconds, then random bits, so ids sort by when they were made.
export const uuidv7 = (now: number, random: RandomBytes = randomBytes): string => {
    const bytes = random(16);
    let time = Math.max(0, Math.floor(now));
    for (let index = 5; index >= 0; index--) {
        bytes[index] = time % 256;
        time = Math.floor(time / 256);
    }
    bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// The header as the sender fills it; the seal adds `v`, the fingerprints, and an id when none is given.
export interface EnvelopeAddressing {
    readonly id?: string;
    readonly from: string;
    readonly to: string;
    readonly kind: S2sEnvelopeHeader["kind"];
    readonly thread?: string | undefined;
    readonly replyTo?: string | undefined;
    readonly as?: string | undefined;
    readonly hops: number;
    readonly sentAt: number;
}

export interface SealInput {
    readonly addressing: EnvelopeAddressing;
    readonly payload: S2sPayload;
    // The sender's current key set, which signs.
    readonly sender: S2sKeySet;
    // The receiver's public keys, as its last verified document has them.
    readonly recipient: S2sPublicKeys;
    readonly random?: RandomBytes;
}

const headerOf = (envelope: S2sEnvelope): S2sEnvelopeHeader => {
    const { enc: _enc, body: _body, sig: _sig, ...header } = envelope;
    return header;
};

// The key's salt: the canonical header and the key agreement both (X-Wing's lesson: bind the ephemeral key and the
// ciphertext into the key itself, not only through the signature), never the GCM nonce, which is not keying material.
const saltOf = (header: S2sEnvelopeHeader, enc: { readonly x25519: string; readonly mlkem768: string }): Uint8Array =>
    sha256(canonicalBytes({ header, enc: { x25519: enc.x25519, mlkem768: enc.mlkem768 } }));

const unsignedOf = (envelope: S2sEnvelope): Omit<S2sEnvelope, "sig"> => {
    const { sig: _sig, ...rest } = envelope;
    return rest;
};

const headerFor = (addressing: EnvelopeAddressing, sender: S2sKeySet, recipient: S2sPublicKeys, random: RandomBytes): S2sEnvelopeHeader => {
    const header: S2sEnvelopeHeader = {
        v: 1,
        id: addressing.id ?? uuidv7(addressing.sentAt, random),
        from: addressing.from,
        fromFp: sender.fingerprint,
        to: addressing.to,
        toFp: fingerprintOf(recipient),
        kind: addressing.kind,
        hops: addressing.hops,
        sentAt: addressing.sentAt,
    };
    if (addressing.thread !== undefined) {
        header.thread = addressing.thread;
    }
    if (addressing.replyTo !== undefined) {
        header.replyTo = addressing.replyTo;
    }
    if (addressing.as !== undefined) {
        header.as = addressing.as;
    }
    return header;
};

// Seals and signs one payload. Seal at each attempt, so a receiver that rotated between attempts still gets one it can
// open. Throws when the payload is not its header's kind, or seals past the body cap.
export const sealEnvelope = ({ addressing, payload, sender, recipient, random = randomBytes }: SealInput): S2sEnvelope => {
    if (payload.kind !== addressing.kind) {
        throw new Error(`s2s envelope: a ${payload.kind} payload under a ${addressing.kind} header`);
    }
    const header = headerFor(addressing, sender, recipient, random);
    const aad = canonicalBytes(header);
    const agreement = encapsulate(recipient, random);
    const key = deriveKey(agreement.secret, saltOf(header, agreement.enc), S2S_INFO);
    const nonce = random(12);
    const sealed = gcm(key, nonce, aad).encrypt(utf8(JSON.stringify(payload)));
    if (sealed.length > S2S_BODY_MAX_BYTES) {
        throw new Error(`s2s envelope: the body seals to ${sealed.length} bytes, past the ${S2S_BODY_MAX_BYTES} cap`);
    }
    const unsigned: Omit<S2sEnvelope, "sig"> = { ...header, enc: { ...agreement.enc, nonce: toBase64Url(nonce) }, body: toBase64Url(sealed) };
    return { ...unsigned, sig: hybridSign("envelope", canonicalBytes(unsigned), secretKeysOf(sender.secret)) };
};

// Whether the sender's keys signed this envelope as it stands: every header field, `enc` and `body`.
export const verifyEnvelope = (envelope: S2sEnvelope, sender: S2sSigningKeys): boolean =>
    hybridVerify("envelope", canonicalBytes(unsignedOf(envelope)), envelope.sig, sender);

// `signature`: the sender's keys did not sign it. `recipient`: none of the key sets offered is the one it was sealed to.
// `decrypt`: it does not open under that key set (tampered, or sealed to another). `malformed`: it opens, but to no
// payload of its header's kind.
export type OpenRefusal = "signature" | "recipient" | "decrypt" | "malformed";
export type Opened =
    | { readonly ok: true; readonly header: S2sEnvelopeHeader; readonly payload: S2sPayload }
    | { readonly ok: false; readonly reason: OpenRefusal };

export interface OpenInput {
    // The pinned sender's public signing keys.
    readonly sender: S2sSigningKeys;
    // Every key set this sandbox can open with: its current one and the kept previous ones.
    readonly keys: readonly S2sKeySet[];
}

const decrypt = (envelope: S2sEnvelope, keySet: S2sKeySet): Uint8Array | undefined => {
    const nonce = fromBase64Url(envelope.enc.nonce);
    const body = fromBase64Url(envelope.body);
    const secret = decapsulate(envelope.enc, secretKeysOf(keySet.secret));
    if (nonce?.length !== 12 || body === undefined || secret === undefined) {
        return undefined;
    }
    const aad = canonicalBytes(headerOf(envelope));
    try {
        return gcm(deriveKey(secret, saltOf(headerOf(envelope), envelope.enc), S2S_INFO), nonce, aad).decrypt(body);
    } catch {
        // allow(silent-catch): a tag that does not verify is what a tampered or misaddressed body looks like.
        return undefined;
    }
};

const payloadOf = (plain: Uint8Array, kind: string): S2sPayload | undefined => {
    try {
        const parsed = S2sPayloadSchema.safeParse(JSON.parse(fromUtf8(plain)));
        return parsed.success && parsed.data.kind === kind ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a body that is not UTF-8 JSON is no payload, which the caller refuses as malformed.
        return undefined;
    }
};

// The payload, opened with the key set the envelope names (`toFp`) and checked to be its header's kind; nothing verified.
const opened = (envelope: S2sEnvelope, keys: readonly S2sKeySet[]): Opened => {
    const keySet = keys.find((candidate) => candidate.fingerprint === envelope.toFp);
    if (keySet === undefined) {
        return { ok: false, reason: "recipient" };
    }
    const plain = decrypt(envelope, keySet);
    if (plain === undefined) {
        return { ok: false, reason: "decrypt" };
    }
    const payload = payloadOf(plain, envelope.kind);
    return payload === undefined ? { ok: false, reason: "malformed" } : { ok: true, header: headerOf(envelope), payload };
};

// Verifies, then opens with the key set the envelope names (`toFp`), checking the payload is its header's kind.
export const openEnvelope = (envelope: S2sEnvelope, { sender, keys }: OpenInput): Opened =>
    verifyEnvelope(envelope, sender) ? opened(envelope, keys) : { ok: false, reason: "signature" };

/**
 * Opens an envelope whose sender's keys ride inside its own body (a stranger's `contact.request`, which embeds its
 * document), then verifies it against the keys `signer` reads off the payload: undefined there, or a signature those keys
 * did not make, is `signature`. What a request proves this way is only that it vouches for itself; whether its address
 * serves that key is the receiver's next check.
 */
export const openSelfSigned = (envelope: S2sEnvelope, keys: readonly S2sKeySet[], signer: (payload: S2sPayload) => S2sSigningKeys | undefined): Opened => {
    const open = opened(envelope, keys);
    if (!open.ok) {
        return open;
    }
    const signing = signer(open.payload);
    return signing !== undefined && verifyEnvelope(envelope, signing) ? open : { ok: false, reason: "signature" };
};
