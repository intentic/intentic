import { verifyExtensionPayload, verifyIdentity, verifyPasskeyCosign } from "@intentic/sandbox-contract/s2s";
import type { S2sSigningKeys, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { type Checkpoint, type CheckpointFacts, originOf, parseCheckpointBody } from "./checkpoint.js";
import { CHECKPOINT_PURPOSE, digestOf, ENTRY_PURPOSE, entryLeaf, EXTENSION_ID, type ServedEntry, type SignedEntry } from "./entry.js";
import { type Hash, rootOf } from "./merkle.js";

/* WHAT A READER CAN CHECK WITHOUT TRUSTING WHOEVER SERVED IT: given a sandbox's identity document (fetched and pinned
   by the reader), a checkpoint and the entries, that the sandbox signed the checkpoint, that every entry is signed by it
   and sits where it says, that a passkey co-signature on an entry is a real assertion over that entry's own digest, that
   an erased position was withdrawn by a later tombstone, and that the entries hash to the checkpoint's root. Pure: the
   caller fetched everything. It does not say the content is true, nor that the sandbox published nothing else to
   someone else; witnesses (a later stage) answer the second. */

export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
const fail = <T>(reason: string): Verdict<T> => ({ ok: false, reason });

// The signing keys for a fingerprint the document vouches for: its own, or the key set its `prev` names.
export const keysFor = (identity: SandboxIdentity, fingerprint: string): S2sSigningKeys | undefined => {
    if (fingerprint === identity.fingerprint) {
        return identity.keys;
    }
    return identity.prev?.by === `key` && identity.prev.fingerprint === fingerprint ? identity.prev.keys : undefined;
};

// The origins a sandbox's log may name: its host's, and each own domain's.
const originsOf = (identity: SandboxIdentity): readonly string[] => [identity.host, ...identity.domains].map((host) => originOf(host));

export const verifyCheckpoint = (identity: SandboxIdentity, checkpoint: Checkpoint): Verdict<CheckpointFacts> => {
    const document = verifyIdentity(identity);
    if (!document.ok) {
        return fail(`the identity document does not verify: ${document.reason}`);
    }
    const keys = keysFor(identity, checkpoint.fingerprint);
    if (keys === undefined) {
        return fail(`the checkpoint is signed by a key the identity document does not vouch for`);
    }
    if (!verifyExtensionPayload(EXTENSION_ID, CHECKPOINT_PURPOSE, { body: checkpoint.body }, checkpoint.sig, keys)) {
        return fail(`the checkpoint's signature does not verify`);
    }
    const facts = parseCheckpointBody(checkpoint.body);
    if (facts === undefined) {
        return fail(`the checkpoint's body is not a tlog checkpoint`);
    }
    return originsOf(identity).includes(facts.origin) ? { ok: true, value: facts } : fail(`the checkpoint names another log (${facts.origin})`);
};

export interface EntryCheck {
    readonly seq: number;
    readonly leaf: Hash;
    readonly signed?: SignedEntry | undefined;
    // Whether a passkey co-signature rides on it and verifies over its digest for this sandbox.
    readonly cosigned: boolean;
}

export const verifyEntry = async (identity: SandboxIdentity, served: ServedEntry): Promise<Verdict<EntryCheck>> => {
    if (!(`signed` in served)) {
        return { ok: true, value: { seq: served.seq, leaf: new Uint8Array(Buffer.from(served.leaf, `hex`)), cosigned: false } };
    }
    const { entry, sig, fingerprint } = served.signed;
    const keys = keysFor(identity, fingerprint);
    if (keys === undefined || !verifyExtensionPayload(EXTENSION_ID, ENTRY_PURPOSE, entry, sig, keys)) {
        return fail(`entry ${served.seq}'s signature does not verify`);
    }
    if (entry.seq !== served.seq) {
        return fail(`entry ${served.seq} says it is entry ${entry.seq}`);
    }
    const digest = digestOf(entry);
    if (digest === undefined) {
        return fail(`entry ${served.seq} is neither a record nor a tombstone`);
    }
    if (entry.cosign !== undefined) {
        const cosign = await verifyPasskeyCosign(entry.cosign, { sandbox: identity.sandbox, digest });
        if (!cosign.ok) {
            return fail(`entry ${served.seq}'s passkey co-signature does not verify: ${cosign.reason}`);
        }
    }
    return { ok: true, value: { seq: served.seq, leaf: entryLeaf(served.signed), signed: served.signed, cosigned: entry.cosign !== undefined } };
};

// An erased position counts only where a later entry withdrew it.
const unwithdrawnErasure = (checks: readonly EntryCheck[]): number | undefined => {
    const withdrawn = new Set(checks.flatMap((check) => (check.signed?.entry.tombstoneOf === undefined ? [] : [check.signed.entry.tombstoneOf])));
    return checks.find((check) => check.signed === undefined && !withdrawn.has(check.seq))?.seq;
};

export interface LogCheck {
    readonly facts: CheckpointFacts;
    readonly entries: readonly EntryCheck[];
}

// The whole log at a checkpoint: every entry from 0 to its size, in order.
export const verifyLog = async (identity: SandboxIdentity, checkpoint: Checkpoint, served: readonly ServedEntry[]): Promise<Verdict<LogCheck>> => {
    const head = verifyCheckpoint(identity, checkpoint);
    if (!head.ok) {
        return head;
    }
    if (served.length !== head.value.size || served.some((entry, at) => entry.seq !== at)) {
        return fail(`the log served ${served.length} entries in order for a checkpoint of ${head.value.size}`);
    }
    const checks: EntryCheck[] = [];
    for (const entry of served) {
        const check = await verifyEntry(identity, entry);
        if (!check.ok) {
            return check;
        }
        checks.push(check.value);
    }
    const erased = unwithdrawnErasure(checks);
    if (erased !== undefined) {
        return fail(`entry ${erased} is served erased, but no later entry withdrew it`);
    }
    const root = rootOf(checks.map((check) => check.leaf));
    return Buffer.from(root).equals(Buffer.from(head.value.root)) ? { ok: true, value: { facts: head.value, entries: checks } } : fail(`the entries do not hash to the checkpoint's root`);
};
