import { PasskeyCosignSchema,canonicalBytes } from "@intentic/sandbox-contract/s2s";
import { HybridSigSchema, S2sFingerprintSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { RecordSchema } from "../server/records.js";
import { leafHash, toHex } from "./merkle.js";

/* ONE ENTRY OF A SANDBOX'S LOG (`intentic-network/1`): a schema.org record this sandbox published, or a tombstone naming
   an earlier one, signed as the sandbox (`api.identity.sign` under `ext:intentic.network/log.entry`). The leaf the tree
   hashes is the canonical JSON of the signed entry, so the signature is inside what the tree commits to. What a person
   approved is a digest anyone recomputes from the entry itself, which is what a passkey co-signature names. */

export const LOG_PROTOCOL = `intentic-network/1`;
export const EXTENSION_ID = `intentic.network`;
export const ENTRY_PURPOSE = `log.entry`;
export const CHECKPOINT_PURPOSE = `log.checkpoint`;
export const CATALOG_PURPOSE = `catalog`;

export const EntrySchema = z.object({
    v: z.literal(1),
    seq: z.number().int().min(0).describe(`Its place in the log, from 0; the same as its leaf index.`),
    publishedAt: z.iso.datetime().describe(`When the sandbox appended it, UTC.`),
    record: RecordSchema.optional().describe(`The published schema.org record; absent on a tombstone.`),
    tombstoneOf: z.number().int().min(0).optional().describe(`The seq of the entry this one withdraws, whose record is then erased.`),
    cosign: PasskeyCosignSchema.optional().describe(`The passkey co-signature of the person who approved it, over its digest.`),
});
export type Entry = z.infer<typeof EntrySchema>;

export const SignedEntrySchema = z.object({
    entry: EntrySchema,
    sig: HybridSigSchema,
    fingerprint: S2sFingerprintSchema.describe(`The key set that signed it, as the sandbox's identity document names it.`),
});
export type SignedEntry = z.infer<typeof SignedEntrySchema>;

// What a reader is served for one position: the signed entry, or, for one a later tombstone withdrew, its leaf hash only.
export const ServedEntrySchema = z.union([
    z.object({ seq: z.number().int().min(0), signed: SignedEntrySchema }),
    z.object({ seq: z.number().int().min(0), erased: z.literal(true), leaf: z.string().regex(/^[0-9a-f]{64}$/u) }),
]);
export type ServedEntry = z.infer<typeof ServedEntrySchema>;

// SHA-256 of a value's canonical JSON, hex: the same bytes whoever computes it.
const hexDigest = <T>(value: T): string => toHex(sha256(canonicalBytes(value)));

// What a person approves for a publication, and what its passkey co-signature names: the record, in this protocol.
export const publishDigest = (record: z.infer<typeof RecordSchema>): string => hexDigest({ protocol: LOG_PROTOCOL, kind: `publish`, record });
// What a person approves to withdraw an entry.
export const withdrawDigest = (seq: number): string => hexDigest({ protocol: LOG_PROTOCOL, kind: `withdraw`, seq });
// The digest a person approved for this entry; undefined for an entry that is neither a record nor a tombstone.
export const digestOf = (entry: Entry): string | undefined => {
    if (entry.tombstoneOf !== undefined) {
        return withdrawDigest(entry.tombstoneOf);
    }
    return entry.record === undefined ? undefined : publishDigest(entry.record);
};

export const entryLeaf = (signed: SignedEntry): Uint8Array => leafHash(canonicalBytes(signed));
