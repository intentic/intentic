// The ownership-stamp contract: a provider stamps every resource with the resource node's id and the intent that owns
// it, so a stateless read can attribute it without a state file. A single-string field (a DNS record comment) uses
// `formatStamp`; a key/value mechanism (a Docker label) uses the keys directly. `parseStamp` reads both string forms.

import { createHash } from "node:crypto";
import type { SerializedValue } from "./types.js";

export const STAMP_KEY = "intentic.id";

// The intent a resource belongs to: the desired-state graph's `owner`. Resources stamped before owners existed
// (2026-10-05) carry none and read as unowned: a scan never prunes them, and the next apply of their node adopts them.
export const OWNER_KEY = "intentic.owner";

// An owner id is one shell word, one Docker label value and a short slice of a 100-character DNS comment.
const OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const isOwnerId = (value: string): boolean => OWNER_PATTERN.test(value);

// The owner goes first: a CLI from before owners lists comments that START with `intentic.id=`, so it never sees an
// owned record, and so can never prune one as its orphan.
export const formatStamp = (id: string, owner?: string): string =>
    owner === undefined ? `${STAMP_KEY}=${id}` : `${OWNER_KEY}=${owner} ${STAMP_KEY}=${id}`;

export interface ParsedStamp {
    readonly id: string;
    // Absent on a legacy stamp, which names no owner.
    readonly owner?: string;
}

// Recovers the id and owner from either string form; anything else (a comment a person wrote) is not a stamp.
export const parseStamp = (encoded: string): ParsedStamp | undefined => {
    const text = encoded.trim();
    if (text.startsWith(`${STAMP_KEY}=`)) {
        const id = text.slice(STAMP_KEY.length + 1);
        return id === "" ? undefined : { id };
    }
    const owned = /^intentic\.owner=(\S+)\s+intentic\.id=(\S+)$/.exec(text);
    if (owned?.[1] === undefined || owned[2] === undefined) {
        return undefined;
    }
    return { id: owned[2], owner: owned[1] };
};

// Rule 6's three answers to "whose is this?": a resource stamped with this intent's owner is mine, one stamped with
// another is theirs, and one with no owner stamp is unowned. With no owner of our own (an artifact resolved before
// owners existed) nothing can be claimed, so an owned stamp is theirs.
export type Ownership = "mine" | "theirs" | "unowned";

export const ownershipOf = (stamped: string | undefined, owner: string | undefined): Ownership => {
    if (stamped === undefined || stamped === "") {
        return "unowned";
    }
    return owner !== undefined && stamped === owner ? "mine" : "theirs";
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
