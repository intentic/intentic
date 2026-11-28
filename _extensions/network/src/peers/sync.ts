import { classifyIdentityChange, verifyExtensionPayload } from "@intentic/sandbox-contract/s2s";
import type { SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { type Checkpoint, type CheckpointFacts, CheckpointSchema } from "../log/checkpoint.js";
import { CATALOG_PURPOSE, EXTENSION_ID, type ServedEntry, ServedEntrySchema } from "../log/entry.js";
import { type Hash, rootOf, toBase64 } from "../log/merkle.js";
import { keysFor, type Verdict, verifyCheckpoint, verifyEntry } from "../log/verify.js";
import type { BridgeItem } from "../server/records.js";
import type { Source } from "../wire.js";
import { DOOR_PREFIX, type PeerNet } from "./net.js";
import type { Peer, PeerStore, Witnessed } from "./peer-store.js";
import { WITNESS_PURPOSE, WitnessAnswerSchema } from "./witness.js";

/* FOLLOWING ANOTHER SANDBOX'S LOG: resolve its address and pin the identity it shows on first contact (later key changes
   go through the s2s rotation table: a rotation its old key vouched for continues, anything else is held for a person);
   read its checkpoint and verify it against the pinned keys; read only the entries past what was verified before, verify
   each, and rebuild the root over the WHOLE history kept here, so a log that rewrote an entry already read, shrank, or
   showed another root at the same size is caught, with both signed checkpoints kept as evidence and the source held.
   Then, best effort, ask the reader's trusted witnesses to cosign the checkpoint, and keep the peer's signed catalog. */

export interface PeerRead {
    readonly items: BridgeItem[];
    // Native ids of items the peer withdrew: they leave this sandbox's store too.
    readonly withdrawn: string[];
}

export interface SyncDeps {
    readonly net: PeerNet;
    readonly peers: PeerStore;
    // The addresses of the witnesses this reader trusts.
    readonly witnesses: () => Promise<readonly string[]>;
    readonly now: () => number;
}

const NOTHING: PeerRead = { items: [], withdrawn: [] };
const PAGE = 200;

const nativeIdOf = (address: string, seq: number): string => `${address}#${seq}`;

const sameRoot = (left: Hash, right: Hash): boolean => Buffer.from(left).equals(Buffer.from(right));

// The identity to verify with: pinned on first contact, carried through a rotation it vouched for, held otherwise.
const identityFor = async (deps: SyncDeps, source: Source): Promise<{ readonly peer: Peer; readonly document: SandboxIdentity } | undefined> => {
    const resolved = await deps.net.resolve(source.address);
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    const pinned = deps.peers.peer(source.id);
    if (pinned === undefined) {
        deps.peers.pin(source.id, resolved.address, resolved.host, resolved.document);
    } else if (pinned.state !== `ok`) {
        return undefined;
    } else {
        const change = classifyIdentityChange({
            pinned: { address: pinned.address, fingerprint: pinned.document.fingerprint, recovery: pinned.document.recovery },
            next: resolved.document,
            address: resolved.address,
            txt: resolved.txt,
        });
        if (change.kind === `key-changed` || change.kind === `unrelated` || change.kind === `invalid`) {
            deps.peers.hold(source.id, `held`, `its key changed with no proof the old key vouched for (${change.kind}); check with its owner before trusting it again`);
            return undefined;
        }
        deps.peers.pin(source.id, resolved.address, resolved.host, resolved.document);
    }
    const peer = deps.peers.peer(source.id);
    return peer === undefined ? undefined : { peer, document: resolved.document };
};

const fetchEntries = async (deps: SyncDeps, host: string, start: number, end: number, signal: AbortSignal): Promise<ServedEntry[]> => {
    const all: ServedEntry[] = [];
    for (let from = start; from < end; from += PAGE) {
        const answer = await deps.net.get(host, `${DOOR_PREFIX}/log/entries?start=${from}&end=${Math.min(end, from + PAGE)}`, signal);
        if (answer.status !== 200) {
            throw new Error(`its log answered HTTP ${answer.status} for entries ${from}…`);
        }
        all.push(...z.object({ entries: z.array(ServedEntrySchema) }).parse(answer.body).entries);
    }
    return all;
};

// What a mismatch against the verified history means, in the words the Peers tab shows.
const equivocation = (deps: SyncDeps, peer: Peer, checkpoint: Checkpoint, why: string): PeerRead => {
    if (peer.checkpoint !== null) {
        deps.peers.hold(peer.sourceId, `equivocation`, why, { earlier: peer.checkpoint, later: checkpoint, why });
    } else {
        deps.peers.hold(peer.sourceId, `held`, why);
    }
    return NOTHING;
};

interface Verified {
    readonly entries: { readonly served: ServedEntry; readonly leaf: Hash }[];
    readonly cosigned: number;
}

const verifyNew = async (document: SandboxIdentity, served: readonly ServedEntry[]): Promise<Verdict<Verified>> => {
    const entries: { readonly served: ServedEntry; readonly leaf: Hash }[] = [];
    let cosigned = 0;
    for (const entry of served) {
        const check = await verifyEntry(document, entry);
        if (!check.ok) {
            return check;
        }
        entries.push({ served: entry, leaf: check.value.leaf });
        cosigned += check.value.cosigned ? 1 : 0;
    }
    return { ok: true, value: { entries, cosigned } };
};

// The new entries' records as feed items, and the positions their tombstones withdrew.
const readOf = (address: string, verified: Verified): PeerRead & { readonly positions: number[] } => {
    const positions = verified.entries.flatMap(({ served }) => (`signed` in served && served.signed.entry.tombstoneOf !== undefined ? [served.signed.entry.tombstoneOf] : []));
    const items = verified.entries.flatMap(({ served }): BridgeItem[] => {
        if (!(`signed` in served) || served.signed.entry.record === undefined || positions.includes(served.seq)) {
            return [];
        }
        return [{ nativeId: nativeIdOf(address, served.seq), record: served.signed.entry.record, verification: `signature-valid`, verifiedBy: `intentic-log`, signingKey: served.signed.fingerprint }];
    });
    return { items, withdrawn: positions.map((seq) => nativeIdOf(address, seq)), positions };
};

// Each trusted witness asked to cosign the checkpoint; only cosignatures that verify are kept.
const askWitnesses = async (deps: SyncDeps, peer: Peer, checkpoint: Checkpoint, facts: CheckpointFacts, signal: AbortSignal): Promise<Witnessed[]> => {
    const kept: Witnessed[] = [];
    for (const address of await deps.witnesses()) {
        try {
            const witness = await deps.net.resolve(address);
            if (!witness.ok) {
                continue;
            }
            const answer = await deps.net.post(witness.host, `${DOOR_PREFIX}/witness/cosign`, { address: peer.address, checkpoint }, signal);
            const parsed = WitnessAnswerSchema.safeParse(answer.body);
            const keys = parsed.success ? keysFor(witness.document, parsed.data.fingerprint) : undefined;
            if (!parsed.success || keys === undefined) {
                continue;
            }
            const { cosignature, sig, fingerprint } = parsed.data;
            const matches = cosignature.origin === facts.origin && cosignature.size === facts.size && cosignature.root === toBase64(facts.root);
            if (matches && verifyExtensionPayload(EXTENSION_ID, WITNESS_PURPOSE, cosignature, sig, keys)) {
                kept.push({ witness: witness.address, fingerprint, size: cosignature.size, cosignedAt: cosignature.cosignedAt });
            }
        } catch {
            // allow(silent-catch): a witness that cannot be reached cosigns nothing this round; the tab counts who did
            continue;
        }
    }
    return kept;
};

const CatalogAnswerSchema = z.object({ catalog: z.record(z.string(), z.json()), sig: z.object({ ed25519: z.string(), mldsa65: z.string() }), fingerprint: z.string() });

const refreshCatalog = async (deps: SyncDeps, peer: Peer, document: SandboxIdentity, signal: AbortSignal): Promise<void> => {
    const answer = await deps.net.get(peer.host, `${DOOR_PREFIX}/catalog`, signal);
    const parsed = CatalogAnswerSchema.safeParse(answer.body);
    const keys = parsed.success ? keysFor(document, parsed.data.fingerprint) : undefined;
    if (parsed.success && keys !== undefined && verifyExtensionPayload(EXTENSION_ID, CATALOG_PURPOSE, parsed.data.catalog, parsed.data.sig, keys)) {
        deps.peers.catalog(peer.sourceId, JSON.stringify(parsed.data));
    }
};

const afterCheckpoint = async (deps: SyncDeps, peer: Peer, document: SandboxIdentity, checkpoint: Checkpoint, facts: CheckpointFacts, signal: AbortSignal): Promise<void> => {
    deps.peers.witnessed(peer.sourceId, await askWitnesses(deps, peer, checkpoint, facts, signal));
    // allow(silent-catch): a catalog that cannot be read now keeps the one verified before
    await refreshCatalog(deps, peer, document, signal).catch(() => undefined);
};

export const syncPeer = async (deps: SyncDeps, source: Source, signal: AbortSignal): Promise<PeerRead> => {
    const pinned = await identityFor(deps, source);
    if (pinned === undefined) {
        return NOTHING;
    }
    const { peer, document } = pinned;
    const answer = await deps.net.get(peer.host, `${DOOR_PREFIX}/log/checkpoint`, signal);
    if (answer.status === 404) {
        return NOTHING;
    }
    const checkpoint = CheckpointSchema.parse(answer.body);
    const head = verifyCheckpoint(document, checkpoint);
    if (!head.ok) {
        deps.peers.hold(peer.sourceId, `held`, head.reason);
        return NOTHING;
    }
    const facts = head.value;
    const known = deps.peers.leaves(peer.sourceId);
    if (facts.size < known.length) {
        return equivocation(deps, peer, checkpoint, `its log shrank from ${known.length} to ${facts.size} entries`);
    }
    if (facts.size === known.length) {
        if (!sameRoot(rootOf(known), facts.root)) {
            return equivocation(deps, peer, checkpoint, `it signed a different log of the same size`);
        }
        await afterCheckpoint(deps, peer, document, checkpoint, facts, signal);
        return NOTHING;
    }
    const checked = await verifyNew(document, await fetchEntries(deps, peer.host, known.length, facts.size, signal));
    if (!checked.ok) {
        deps.peers.hold(peer.sourceId, `held`, checked.reason);
        return NOTHING;
    }
    const verified = checked.value;
    if (!sameRoot(rootOf([...known, ...verified.entries.map((entry) => entry.leaf)]), facts.root)) {
        return equivocation(deps, peer, checkpoint, `its entries do not hash to the root it signed: its history was rewritten`);
    }
    const read = readOf(peer.address, verified);
    deps.peers.appendVerified(peer.sourceId, { checkpoint, entries: verified.entries, cosigned: verified.cosigned, withdrawn: read.positions }, deps.now());
    await afterCheckpoint(deps, peer, document, checkpoint, facts, signal);
    return { items: read.items, withdrawn: read.withdrawn };
};
