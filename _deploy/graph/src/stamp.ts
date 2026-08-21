// The ownership-stamp contract: defined ONCE in the protocol, applied per-provider in its native mechanism.
// A provider stamps every resource it creates with the resource node's id, so a later stateless
// read (introspect) can attribute it without any local state file. The KEY is canonical here; the
// stamp value is always the compiled ResourceNode.id.
//
// Mechanisms differ per backend: a single-string field (a Cloudflare DNS record comment) carries the
// `formatStamp` encoding, while a key/value mechanism (a Docker label) uses STAMP_KEY as the label key
// and the id as the value directly. parseStamp recovers the id from the single-string form.

import { createHash } from "node:crypto";
import type { SerializedValue } from "./types.js";

export const STAMP_KEY = "intentic.id";

export const formatStamp = (id: string): string => `${STAMP_KEY}=${id}`;

export const parseStamp = (encoded: string): string | undefined => {
    const prefix = `${STAMP_KEY}=`;
    return encoded.startsWith(prefix) ? encoded.slice(prefix.length) : undefined;
};

// The drift-stamp: a provider stamps each resource with the hash of its node's SERIALIZED inputs (the
// artifact form: $secret/$ref placeholders, never values, so the stamp is safe in world-readable
// metadata) and reports it back on read; the engine flags a mismatch as an update without any provider
// diff code. Value drift behind a ref/secret is invisible by design, providers' own diffs cover the
// fields that legitimately drift live (image pins).
export const HASH_KEY = "intentic.hash";

const sortKeys = (value: SerializedValue): SerializedValue => {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, sortKeys(entry)]),
        );
    }
    return value;
};

export const hashInputs = (inputs: Readonly<Record<string, SerializedValue>>): string =>
    createHash("sha256")
        .update(JSON.stringify(sortKeys(inputs)))
        .digest("hex")
        .slice(0, 16);
