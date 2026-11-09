import { keyFingerprint, seal, unseal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringSyncItem, KeyringSyncPairSchema, KeyringSyncPeer } from "@intentic/sandbox-contract/schemas/keyring";
import type { z } from "zod";
import { PENDING_SYNC_MAX, type StoredEntry, StoredEntrySchema, type VaultDocument } from "../vault.js";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";
import { withTrashed } from "./removed.js";

type KeyringSyncPair = z.infer<typeof KeyringSyncPairSchema>;

// KEEPING TWO KEYRINGS IN STEP: a pairing at the person's yes on both computers, then each change of an entry sealed to
// the other keyring's sync key and carried by the sandboxes between them. The newer change of an entry wins, a removal
// included (kept in Recently deleted on both sides); each computer's shares stay its own. Moved out of core.ts
// (2026-11-09), reaching the vault through VaultAccess as the Passwords app's ops do.

// A sync item carries one entry, without its shares: each computer shares its own entries with its own sandboxes.
const SyncEntrySchema = StoredEntrySchema.omit({ shares: true, revision: true });
type SyncEntry = z.infer<typeof SyncEntrySchema>;

const syncEntryOf = (entry: StoredEntry): SyncEntry => {
    const sent: SyncEntry = { name: entry.name, rules: entry.rules, source: entry.source, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    if (entry.backend !== undefined) {
        sent.backend = entry.backend;
    }
    if (entry.value !== undefined) {
        sent.value = entry.value;
    }
    if (entry.deleted === true) {
        sent.deleted = true;
    }
    return sent;
};


export interface Merged {
    readonly doc: VaultDocument;
    readonly accepted: number;
}

export class Sync {
    constructor(private readonly vault: VaultAccess) {}

    async state(): Answer<"sync-state"> {
        const keys = await this.vault.keys();
        const file = this.vault.file();
        if (file === undefined || keys.sync === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        return { ok: true, sync: { key: keys.sync, peers: file.open.peers, revision: file.open.revision } };
    }

    async pair(pair: KeyringSyncPair): Answer<"sync-pair"> {
        const file = this.vault.file();
        const keys = await this.vault.keys();
        if (file === undefined || keys.sync === undefined) {
            return refuse("locked", NOT_SET_UP);
        }
        const opened = await this.vault.open(file, {
            title: `Pair with the keyring on ${pair.peer.device}?`,
            message: `This keyring (${pair.self}) is ${keyFingerprint(keys.sync)}; the one on ${pair.peer.device} is ${keyFingerprint(pair.peer.key)}. Say yes only if ${pair.peer.device} shows these same two. Paired, each keeps the other's entries in step.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const peer: KeyringSyncPeer = { device: pair.peer.device, key: pair.peer.key, pairedAt: this.vault.deps.now() };
        const peers = [...opened.doc.peers.filter((other) => other.key !== peer.key && other.device !== peer.device), peer];
        // A new peer is sent everything once: its mark starts before the first revision.
        await this.vault.commit({ doc: { ...opened.doc, peers, syncSent: { ...opened.doc.syncSent, [peer.key]: -1 } }, key: opened.key });
        await this.vault.record({ op: "sync-pair", outcome: "done", target: peer.device, asked: true });
        return { ok: true };
    }

    // One peer's share of the outbox: every entry changed since it was last sent, one sealed item each.
    #outboxFor(doc: VaultDocument, peer: KeyringSyncPeer): KeyringSyncItem[] {
        const since = doc.syncSent?.[peer.key] ?? -1;
        return Object.values(doc.entries)
            .filter((entry) => entry.revision > since)
            .map((entry) => ({
                from: doc.sync.publicKey,
                to: peer.key,
                revision: entry.revision,
                sealed: seal(peer.key, JSON.stringify(syncEntryOf(entry)), { kind: "sync", account: doc.sync.publicKey, device: peer.key, revision: entry.revision }),
            }));
    }

    // Only while unlocked: sealing an entry needs its value, and a sync is not worth a prompt.
    async outbox(): Answer<"sync-outbox"> {
        const held = this.vault.held();
        if (held === undefined || held.doc.peers.length === 0) {
            return { ok: true, items: [] };
        }
        const items = held.doc.peers.flatMap((peer) => this.#outboxFor(held.doc, peer));
        if (items.length > 0) {
            const syncSent = Object.fromEntries(held.doc.peers.map((peer) => [peer.key, held.doc.revision]));
            await this.vault.commit({ doc: { ...held.doc, syncSent: { ...held.doc.syncSent, ...syncSent } }, key: held.key });
        }
        return { ok: true, items };
    }

    async deliver(items: readonly KeyringSyncItem[]): Answer<"sync-deliver"> {
        const file = this.vault.file();
        const keys = await this.vault.keys();
        if (file === undefined || keys.sync === undefined) {
            return { ok: true, accepted: 0 };
        }
        const peers = new Set(file.open.peers.map((peer) => peer.key));
        const ours = items.filter((item) => item.to === keys.sync && peers.has(item.from));
        const held = this.vault.held();
        if (held === undefined) {
            await this.vault.writeOpen({ ...file.open, pendingSync: [...file.open.pendingSync, ...ours].slice(-PENDING_SYNC_MAX) });
            return { ok: true, accepted: ours.length };
        }
        const merged = this.merge(held.doc, ours);
        if (merged.accepted > 0) {
            await this.vault.commit({ doc: merged.doc, key: held.key });
        }
        return { ok: true, accepted: merged.accepted };
    }

    // One item opened and checked as an entry of this vault, or undefined for one that does not open or parse.
    #syncedEntry(doc: VaultDocument, item: KeyringSyncItem): StoredEntry | undefined {
        try {
            const incoming = SyncEntrySchema.parse(JSON.parse(unseal(doc.sync, item.sealed, { kind: "sync", account: item.from, device: item.to, revision: item.revision })));
            const local = doc.entries[incoming.name];
            const shares = incoming.deleted === true ? [] : (local?.shares ?? []);
            return StoredEntrySchema.parse({ ...incoming, shares, revision: doc.revision + 1 });
        } catch {
            // allow(silent-catch): an item that does not open or parse is not the paired keyring's, and is counted out
            return undefined;
        }
    }

    // Items merged: the newer change of an entry wins, a removal included; shares stay this computer's.
    merge(doc: VaultDocument, items: readonly KeyringSyncItem[]): Merged {
        const peers = new Set(doc.peers.map((peer) => peer.key));
        const entries = { ...doc.entries };
        let kept = doc;
        let accepted = 0;
        for (const item of items) {
            const incoming = peers.has(item.from) && item.to === doc.sync.publicKey ? this.#syncedEntry(doc, item) : undefined;
            if (incoming !== undefined) {
                const local = entries[incoming.name];
                if (local === undefined || local.updatedAt < incoming.updatedAt) {
                    // Removed on the other computer: kept in this one's Recently deleted too, so it can be put back here.
                    if (incoming.deleted === true && local !== undefined && local.deleted !== true) {
                        kept = withTrashed(kept, local, this.vault.deps.now());
                    }
                    entries[incoming.name] = incoming;
                }
                accepted++;
            }
        }
        return { doc: { ...kept, entries }, accepted };
    }
}
