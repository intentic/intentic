// The ownership-stamp contract: a provider stamps every resource with the resource node's id, so a stateless
// read can attribute it without a state file. A single-string field uses `formatStamp`; a key/value mechanism (a
// Docker label) uses STAMP_KEY directly. `parseStamp` recovers the id from the single-string form.

import { createHash } from "node:crypto";
import type { SerializedValue } from "./types.js";

export const STAMP_KEY = "intentic.id";

export const formatStamp = (id: string): string => `${STAMP_KEY}=${id}`;

export const parseStamp = (encoded: string): string | undefined => {
    const prefix = `${STAMP_KEY}=`;
    return encoded.startsWith(prefix) ? encoded.slice(prefix.length) : undefined;
};

// Hash of the node's serialized inputs, stamped + read back; a mismatch flags update without provider diff code.
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
