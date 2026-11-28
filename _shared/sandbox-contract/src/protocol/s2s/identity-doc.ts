import {
    S2S_PROTOCOL,
    type S2sIdentityPrev,
    type S2sTxtRecord,
    type SandboxIdentity,
} from "../../schemas/s2s-identity.js";
import { canonicalBytes } from "./canonical.js";
import { fingerprintOf, recoveryFingerprintOf, type S2sKeySet, type S2sRecoveryKey, secretKeysOf } from "./keys.js";
import { hybridSign, hybridVerify } from "./sign.js";

// THE IDENTITY DOCUMENT (schemas/s2s-identity.ts SandboxIdentitySchema): made and signed by its own key set, carrying in
// `prev` the previous key set's (or the recovery key's) vouch for it when the key changed. And what a contact concludes
// when the document a sandbox now serves is not the one it pinned: the rotation table of docs/architecture/messages.md
// as one pure function.

// What a document says of its sandbox, besides its keys.
export interface IdentityFacts {
    readonly sandbox: string;
    readonly name: string;
    readonly host: string;
    readonly domains: readonly string[];
    readonly recovery?: string | undefined;
    readonly issuedAt: number;
}

// Who vouches for a new key set: the one before it, or the recovery key.
export type PrevSigner = { readonly by: "key"; readonly keySet: S2sKeySet } | { readonly by: "recovery"; readonly recovery: S2sRecoveryKey };

type KeyPrev = Extract<S2sIdentityPrev, { readonly by: "key" }>;
type RecoveryPrev = Extract<S2sIdentityPrev, { readonly by: "recovery" }>;

// What a vouch signs: the sandbox, its new key set's fingerprint, and who vouches when.
const vouchBody = (sandbox: string, successor: string, prev: Pick<S2sIdentityPrev, "by" | "fingerprint" | "at">) =>
    canonicalBytes({ sandbox, successor, by: prev.by, fingerprint: prev.fingerprint, at: prev.at });

// The previous key set's, or the recovery key's, vouch that `successor` follows it for this sandbox: made once, when the
// key changes, and carried as the `prev` of every document the successor signs after.
export const vouchFor = (sandbox: string, successor: S2sKeySet, signer: PrevSigner, at: number): S2sIdentityPrev => {
    if (signer.by === "key") {
        const claim: Omit<KeyPrev, "sig"> = { by: "key", fingerprint: signer.keySet.fingerprint, keys: signer.keySet.public, at };
        return { ...claim, sig: hybridSign("identity-prev", vouchBody(sandbox, successor.fingerprint, claim), secretKeysOf(signer.keySet.secret)) };
    }
    const claim: Omit<RecoveryPrev, "sig"> = { by: "recovery", fingerprint: signer.recovery.fingerprint, keys: signer.recovery.public, at };
    return { ...claim, sig: hybridSign("identity-prev", vouchBody(sandbox, successor.fingerprint, claim), signer.recovery) };
};

// A document for these facts under this key set, signed by it, carrying the vouch for it when it has one.
export const signIdentity = (facts: IdentityFacts, keySet: S2sKeySet, prev?: S2sIdentityPrev): SandboxIdentity => {
    const unsigned: Omit<SandboxIdentity, "sig"> = {
        v: 1,
        sandbox: facts.sandbox,
        name: facts.name,
        host: facts.host,
        domains: [...new Set(facts.domains)].toSorted(),
        keys: keySet.public,
        fingerprint: keySet.fingerprint,
        protocols: [S2S_PROTOCOL],
        issuedAt: facts.issuedAt,
    };
    if (facts.recovery !== undefined) {
        unsigned.recovery = facts.recovery;
    }
    if (prev !== undefined) {
        unsigned.prev = prev;
    }
    return { ...unsigned, sig: hybridSign("identity", canonicalBytes(unsigned), secretKeysOf(keySet.secret)) };
};

// The bytes `sig` is over: the document without it, `prev` included.
const selfBody = (doc: SandboxIdentity): Omit<SandboxIdentity, "sig"> => {
    const { sig: _sig, ...rest } = doc;
    return rest;
};

export type IdentityCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const prevProblem = (doc: SandboxIdentity, prev: S2sIdentityPrev): string | undefined => {
    const fingerprint = prev.by === "key" ? fingerprintOf(prev.keys) : recoveryFingerprintOf(prev.keys);
    if (fingerprint !== prev.fingerprint) {
        return "its prev keys are not the ones prev's fingerprint names";
    }
    return hybridVerify("identity-prev", vouchBody(doc.sandbox, doc.fingerprint, prev), prev.sig, prev.keys) ? undefined : "its prev signature does not verify";
};

// Whether a document is what it says: its fingerprint is over its keys, its own signature verifies with them, and a
// `prev` it carries verifies with the keys it names. Says nothing about whether those are keys anyone trusts.
export const verifyIdentity = (doc: SandboxIdentity): IdentityCheck => {
    if (fingerprintOf(doc.keys) !== doc.fingerprint) {
        return { ok: false, reason: "its fingerprint is not over its keys" };
    }
    if (!hybridVerify("identity", canonicalBytes(selfBody(doc)), doc.sig, doc.keys)) {
        return { ok: false, reason: "its signature does not verify" };
    }
    const problem = doc.prev === undefined ? undefined : prevProblem(doc, doc.prev);
    return problem === undefined ? { ok: true } : { ok: false, reason: problem };
};

// Whether the far daemon speaks this protocol, by its own document.
export const speaksS2s = (doc: Pick<SandboxIdentity, "protocols">): boolean => doc.protocols.includes(S2S_PROTOCOL);

// What a contact pinned: where it reached the sandbox, its key, and its recovery key's fingerprint when it had one.
export interface PinnedIdentity {
    readonly address: string;
    readonly fingerprint: string;
    readonly recovery?: string | undefined;
}

// What the document now served means for the contact. `unchanged`: the pinned key. `rotated`, `recovered`,
// `rekeyed-by-domain`: a new key, accepted with that notice (the last a warning). `key-changed`: a new key with no proof,
// held both ways until a person trusts it. `moved`: a new address, proven by the pinned key (`same-key`), or by a `prev`
// the pinned key or recovery key signed. `unrelated`: a new address with no such proof, so a new contact, not this one.
// `invalid`: the document does not verify at all.
export type IdentityChange =
    | { readonly kind: "unchanged" | "rotated" | "recovered" | "rekeyed-by-domain" | "key-changed" | "unrelated" }
    | { readonly kind: "moved"; readonly via: "same-key" | "rotated" | "recovered" }
    | { readonly kind: "invalid"; readonly reason: string };

export interface IdentityChangeInput {
    readonly pinned: PinnedIdentity;
    // The document as fetched now.
    readonly next: SandboxIdentity;
    // The address it was resolved from.
    readonly address: string;
    // The address's TXT record, when it has one (address.ts resolveAddress).
    readonly txt?: S2sTxtRecord | undefined;
}

type Continuity = "same-key" | "rotated" | "recovered" | undefined;

const continuityOf = (pinned: PinnedIdentity, next: SandboxIdentity): Continuity => {
    if (next.fingerprint === pinned.fingerprint) {
        return "same-key";
    }
    if (next.prev?.by === "key" && next.prev.fingerprint === pinned.fingerprint) {
        return "rotated";
    }
    if (next.prev?.by === "recovery" && pinned.recovery !== undefined && next.prev.fingerprint === pinned.recovery) {
        return "recovered";
    }
    return undefined;
};

// The rotation table (docs/architecture/messages.md, "Rotation and recovery"). Pure: the caller fetched the document
// and the record, and only a document that verifies is weighed.
export const classifyIdentityChange = ({ pinned, next, address, txt }: IdentityChangeInput): IdentityChange => {
    const check = verifyIdentity(next);
    if (!check.ok) {
        return { kind: "invalid", reason: check.reason };
    }
    const continuity = continuityOf(pinned, next);
    if (address !== pinned.address) {
        return continuity === undefined ? { kind: "unrelated" } : { kind: "moved", via: continuity };
    }
    if (continuity === "same-key") {
        return { kind: "unchanged" };
    }
    if (continuity !== undefined) {
        return { kind: continuity };
    }
    const isDomain = address !== next.host && next.domains.includes(address);
    return isDomain && txt?.fingerprint === next.fingerprint && txt.host === next.host ? { kind: "rekeyed-by-domain" } : { kind: "key-changed" };
};
