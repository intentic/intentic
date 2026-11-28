import { sha256 } from "@noble/hashes/sha2.js";
import {
    S2S_ATTESTATION_VALID_MAX_MS,
    type S2sAttestation,
    type S2sClaims,
    S2sClaimsSchema,
    type S2sSandboxVouch,
    S2sSandboxVouchSchema,
    type SandboxIdentity,
} from "../../schemas/s2s-identity.js";
import { canonicalBytes, toBase32 } from "./canonical.js";
import { verifyIdentity } from "./identity-doc.js";
import { fingerprintOf, type S2sKeySet, secretKeysOf } from "./keys.js";
import { hybridSign, hybridVerify } from "./sign.js";

// ATTESTATIONS (schemas/s2s-identity.ts S2sAttestationSchema, docs/architecture/messages.md "Attestations"): one sandbox's
// signed word about another, which the other carries in its own identity document. Pure: making one under a key set,
// and checking one against the document of the sandbox it is about. A check says whether it is what it says (the
// issuer's keys, its signature, its dates, its subject), and separately whether the reader trusts its issuer, which only
// the reader's own list of fingerprints decides: nothing here vouches for any issuer.

// How far ahead of the reader's clock an attestation may be dated, as for an envelope.
const ISSUED_AHEAD_MAX_MS = 5 * 60 * 1000;

// Who signs, as the issuing sandbox's own document says it.
export interface AttestationIssuer {
    readonly sandbox: string;
    readonly address: string;
    readonly name?: string | undefined;
}

// What the issuer vouches for, about which sandbox under which key, and for how long.
export interface AttestationInput {
    readonly issuer: AttestationIssuer;
    readonly subject: { readonly sandbox: string; readonly address: string; readonly fingerprint: string };
    readonly claims: S2sClaims;
    readonly issuedAt: number;
    readonly validUntil: number;
}

// Why the dates cannot be: none, or the reason in words.
const datesProblem = (issuedAt: number, validUntil: number): string | undefined => {
    if (validUntil <= issuedAt) {
        return "it lapses before it was made";
    }
    return validUntil - issuedAt > S2S_ATTESTATION_VALID_MAX_MS ? "it claims to be valid for more than a year" : undefined;
};

// The bytes a signature is over: the attestation without `sig`, every field this build does not know included.
const signedBodyOf = (attestation: S2sAttestation): Uint8Array => {
    if (!("sig" in attestation)) {
        return canonicalBytes(attestation);
    }
    const { sig: _sig, ...rest } = attestation;
    return canonicalBytes(rest);
};

/**
 * A `sandbox-vouch` for the input, signed by this key set for `attestation`, carrying its public keys and fingerprint
 * so a reader checks it with nothing else. Throws on claims the schema refuses or dates past a year.
 */
export const signAttestation = (input: AttestationInput, keySet: S2sKeySet): S2sSandboxVouch => {
    const problem = datesProblem(input.issuedAt, input.validUntil);
    if (problem !== undefined) {
        throw new RangeError(`an attestation cannot be signed: ${problem}`);
    }
    const issuer: S2sSandboxVouch["issuer"] = { sandbox: input.issuer.sandbox, address: input.issuer.address, fingerprint: keySet.fingerprint, keys: { ...keySet.public } };
    if (input.issuer.name !== undefined) {
        issuer.name = input.issuer.name;
    }
    const unsigned: Omit<S2sSandboxVouch, "sig"> = {
        v: 1,
        type: "sandbox-vouch",
        issuer,
        subject: { sandbox: input.subject.sandbox, address: input.subject.address, fingerprint: input.subject.fingerprint },
        claims: S2sClaimsSchema.parse(input.claims),
        issuedAt: input.issuedAt,
        validUntil: input.validUntil,
    };
    return { ...unsigned, sig: hybridSign("attestation", canonicalBytes(unsigned), secretKeysOf(keySet.secret)) };
};

/** An attestation's id: the base32 of the SHA-256 over it without `sig`, cut to 26 characters (130 bits). */
export const attestationIdOf = (attestation: S2sAttestation): string => toBase32(sha256(signedBodyOf(attestation))).slice(0, 26);

/** The attestation as a `sandbox-vouch` this build reads, or undefined when it is another type or does not parse as one. */
export const sandboxVouchOf = (attestation: S2sAttestation): S2sSandboxVouch | undefined =>
    attestation.type === "sandbox-vouch" ? S2sSandboxVouchSchema.safeParse(attestation).data : undefined;

// `trusted` only ever with `ok`: an attestation that is not what it says is trusted by nobody.
export type AttestationCheck = { readonly ok: true; readonly trusted: boolean } | { readonly ok: false; readonly reason: string; readonly trusted: false };

export interface AttestationCheckOptions {
    // The reader's clock, in epoch milliseconds.
    readonly now: number;
    // The issuers this reader trusts, by fingerprint; absent, none.
    readonly trustedIssuers?: Iterable<string> | undefined;
}

const failed = (reason: string): AttestationCheck => ({ ok: false, reason, trusted: false });

// The key set fingerprints a document stands for: its own, and the one its `prev` names when the previous key vouched.
const keysOfDocument = (doc: SandboxIdentity): readonly string[] => (doc.prev?.by === "key" ? [doc.fingerprint, doc.prev.fingerprint] : [doc.fingerprint]);

// What is wrong with a vouch about this document as of `now`, cheapest first, the signature last.
const vouchProblem = (vouch: S2sSandboxVouch, subject: SandboxIdentity, now: number): string | undefined => {
    const keys = keysOfDocument(subject);
    if (fingerprintOf(vouch.issuer.keys) !== vouch.issuer.fingerprint) {
        return "its issuer's fingerprint is not over the keys it carries";
    }
    if (vouch.subject.sandbox !== subject.sandbox) {
        return `it is about sandbox ${vouch.subject.sandbox}, not ${subject.sandbox}`;
    }
    if (keys.includes(vouch.issuer.fingerprint)) {
        return "a sandbox cannot vouch for itself";
    }
    if (!keys.includes(vouch.subject.fingerprint)) {
        return `it names key ${vouch.subject.fingerprint}, which is neither this sandbox's key nor the one before it: its issuer has to vouch again`;
    }
    const dates = datesProblem(vouch.issuedAt, vouch.validUntil);
    if (dates !== undefined) {
        return dates;
    }
    if (vouch.issuedAt > now + ISSUED_AHEAD_MAX_MS) {
        return `it is dated ${new Date(vouch.issuedAt).toISOString()}, ahead of this clock`;
    }
    if (vouch.validUntil <= now) {
        return `it lapsed at ${new Date(vouch.validUntil).toISOString()}`;
    }
    return hybridVerify("attestation", signedBodyOf(vouch), vouch.sig, vouch.issuer.keys) ? undefined : "its signature does not verify";
};

/**
 * Whether an attestation is what it says about the sandbox whose document is given (one the caller already verified,
 * verifyIdentity, or took from verifyAttestations): its issuer's fingerprint is over the keys it carries, its signature
 * verifies under them, it is current, it is about this sandbox, and about this document's key or the one its `prev` was
 * vouched for by (so one rotation keeps it; a second, or a recovery, needs it issued again). `trusted` when, besides, the
 * reader lists its issuer. An `eudi-pid` or a type this build does not know is never `ok`.
 */
export const verifyAttestation = (attestation: S2sAttestation, subject: SandboxIdentity, opts: AttestationCheckOptions): AttestationCheck => {
    if (attestation.type === "eudi-pid") {
        return failed("an EU wallet attestation is not supported yet");
    }
    if (attestation.type !== "sandbox-vouch") {
        return failed(`a ${attestation.type.slice(0, 64)} attestation is not one this build reads`);
    }
    const vouch = sandboxVouchOf(attestation);
    if (vouch === undefined) {
        return failed("it does not read as a sandbox vouch");
    }
    const problem = vouchProblem(vouch, subject, opts.now);
    if (problem !== undefined) {
        return failed(problem);
    }
    return { ok: true, trusted: new Set(opts.trustedIssuers ?? []).has(vouch.issuer.fingerprint) };
};

// One attestation a document carries, with its id and what checking it came to.
export interface CheckedAttestation {
    readonly id: string;
    readonly attestation: S2sAttestation;
    readonly check: AttestationCheck;
}

/** Every attestation a document carries, each checked against it, once the document itself verifies; else each fails so. */
export const verifyAttestations = (doc: SandboxIdentity, opts: AttestationCheckOptions): readonly CheckedAttestation[] => {
    const own = verifyIdentity(doc);
    return (doc.attestations ?? []).map((attestation) => ({
        id: attestationIdOf(attestation),
        attestation,
        check: own.ok ? verifyAttestation(attestation, doc, opts) : failed(`the document carrying it does not verify: ${own.reason}`),
    }));
};
