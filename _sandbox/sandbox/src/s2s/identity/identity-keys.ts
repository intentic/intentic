import { keySetFromSeeds, type S2sKeySet } from "@intentic/sandbox-contract/s2s";
import {
    S2S_PREVIOUS_KEYS_MAX,
    S2sBase64UrlSchema,
    S2sFingerprintSchema,
    S2sIdentityPrevSchema,
    S2sRecoveryFingerprintSchema,
    S2sSigningKeysSchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import type { JsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";

// THIS SANDBOX'S KEYS (docs/architecture/messages.md, "Identity"): the current hybrid key set as the four seeds it is
// derived from, up to three before it (so an envelope sealed to a key just rotated away still opens), the vouch that
// carried the current one over from the one before, and a recovery key's public half. In the auth root, mode 0600, out of
// every agent's reach; a file this build cannot read is refused rather than replaced, since nothing could grow the same
// keys back.

const SeedsSchema = z.object({
    ed25519: S2sBase64UrlSchema,
    mldsa65: S2sBase64UrlSchema,
    x25519: S2sBase64UrlSchema,
    mlkem768: S2sBase64UrlSchema,
});

const StoredKeySetSchema = z.object({
    seeds: SeedsSchema,
    // Recorded beside the seeds so a reader can name the key without deriving it; checked against them on load.
    fingerprint: S2sFingerprintSchema,
    createdAt: z.number().int(),
    // The vouch of the key set before (or of the recovery key) for this one, carried as its documents' `prev`.
    prev: S2sIdentityPrevSchema.optional(),
});
export type StoredKeySet = z.infer<typeof StoredKeySetSchema>;

const RetiredKeySetSchema = StoredKeySetSchema.extend({ retiredAt: z.number().int() });

const IdentityKeysSchema = z.object({
    // Absent until something first needs the identity.
    current: StoredKeySetSchema.optional(),
    // Newest first, at most S2S_PREVIOUS_KEYS_MAX.
    previous: z.array(RetiredKeySetSchema).max(S2S_PREVIOUS_KEYS_MAX),
    recovery: z
        .object({
            keys: S2sSigningKeysSchema,
            fingerprint: S2sRecoveryFingerprintSchema,
            createdAt: z.number().int(),
        })
        .optional(),
});
export type IdentityKeys = z.infer<typeof IdentityKeysSchema>;

export const sandboxIdentityDocument = defineDocument({ root: "auth", path: "sandbox-identity.json", schema: IdentityKeysSchema });

export const openIdentityKeys = (path: string): JsonFile<IdentityKeys> =>
    openDocument(sandboxIdentityDocument, path, { fallback: () => ({ previous: [] }), mode: 0o600, onUnreadable: "refuse" });

// A stored key set as one signs and opens with; throws when its seeds no longer derive the fingerprint recorded beside
// them, which only a hand-edited file could do.
export const keySetOf = (stored: StoredKeySet): S2sKeySet => {
    const set = keySetFromSeeds(stored.seeds);
    if (set.fingerprint !== stored.fingerprint) {
        throw new Error(`sandbox-identity.json: the seeds of ${stored.fingerprint} derive ${set.fingerprint}`);
    }
    return set;
};

// A key set as it is stored: its seeds and fingerprint.
export const storedOf = (set: S2sKeySet, createdAt: number, prev?: StoredKeySet["prev"]): StoredKeySet => {
    const stored: StoredKeySet = { seeds: { ...set.secret }, fingerprint: set.fingerprint, createdAt };
    if (prev !== undefined) {
        stored.prev = prev;
    }
    return stored;
};

// The keys after `next` replaced the current set: the current one retired to the front of `previous`, the oldest
// dropped past the limit.
export const succeeded = (keys: IdentityKeys, next: StoredKeySet, at: number): IdentityKeys => ({
    ...keys,
    current: next,
    previous: (keys.current === undefined ? keys.previous : [{ ...keys.current, retiredAt: at }, ...keys.previous]).slice(0, S2S_PREVIOUS_KEYS_MAX),
});
