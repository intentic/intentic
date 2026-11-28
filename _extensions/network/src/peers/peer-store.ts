import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type SandboxIdentity, SandboxIdentitySchema } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { type Checkpoint, CheckpointSchema } from "../log/checkpoint.js";
import { type ServedEntry, SignedEntrySchema } from "../log/entry.js";
import { type Hash, toHex } from "../log/merkle.js";

/* THE SANDBOXES THIS ONE FOLLOWS, ON DISK (migration 3 of server/store.ts). Each is a source of kind `intentic`, and its
   row here holds the identity document pinned on first contact, the last checkpoint verified, how many of its entries
   carried a passkey co-signature, which witnesses cosigned that checkpoint, its signed catalog, and, when it was caught
   rewriting its history, the two checkpoints that prove it. Every leaf is kept, so a later checkpoint is checked against
   the whole history this sandbox already verified. As a witness: the last checkpoint cosigned for each log. */

type Row = Record<string, SQLOutputValue>;

export const PeerStateSchema = z.enum([`ok`, `held`, `equivocation`]);
export type PeerState = z.infer<typeof PeerStateSchema>;

// A witness's cosignature of a peer's checkpoint, as this reader verified it.
export const WitnessedSchema = z.object({ witness: z.string(), fingerprint: z.string(), size: z.number(), cosignedAt: z.string() });
export type Witnessed = z.infer<typeof WitnessedSchema>;

// What proves an equivocation: the checkpoint verified before, and the signed one that cannot follow it.
export const EvidenceSchema = z.object({ earlier: CheckpointSchema, later: CheckpointSchema, why: z.string() });
export type Evidence = z.infer<typeof EvidenceSchema>;

export interface Peer {
    readonly sourceId: string;
    readonly address: string;
    readonly host: string;
    readonly document: SandboxIdentity;
    readonly state: PeerState;
    readonly problem: string | null;
    readonly checkpoint: Checkpoint | null;
    readonly size: number;
    readonly cosigned: number;
    readonly witnessed: readonly Witnessed[];
    readonly catalog: string | null;
    readonly evidence: Evidence | null;
    readonly syncedAt: number | null;
}

const PeerRowSchema = z.object({
    sourceId: z.string(),
    address: z.string(),
    host: z.string(),
    document: z.string(),
    state: PeerStateSchema,
    problem: z.string().nullable(),
    checkpoint: z.string().nullable(),
    size: z.number(),
    cosigned: z.number(),
    witnessed: z.string(),
    catalog: z.string().nullable(),
    evidence: z.string().nullable(),
    syncedAt: z.number().nullable(),
});

const peerOf = (raw: Row): Peer => {
    const row = PeerRowSchema.parse(raw);
    return {
        ...row,
        document: SandboxIdentitySchema.parse(JSON.parse(row.document)),
        checkpoint: row.checkpoint === null ? null : CheckpointSchema.parse(JSON.parse(row.checkpoint)),
        witnessed: z.array(WitnessedSchema).parse(JSON.parse(row.witnessed)),
        evidence: row.evidence === null ? null : EvidenceSchema.parse(JSON.parse(row.evidence)),
    };
};

export interface VerifiedAppend {
    readonly checkpoint: Checkpoint;
    readonly entries: readonly { readonly served: ServedEntry; readonly leaf: Hash }[];
    readonly cosigned: number;
    // Earlier positions a new tombstone withdrew: their copies are erased here too.
    readonly withdrawn: readonly number[];
}

export class PeerStore {
    constructor(private readonly db: DatabaseSync) {}

    peer(sourceId: string): Peer | undefined {
        const row = this.db.prepare(`SELECT * FROM peers WHERE sourceId = ?`).get(sourceId);
        return row === undefined ? undefined : peerOf(row);
    }

    peers(): Peer[] {
        return this.db.prepare(`SELECT * FROM peers ORDER BY address`).all().map(peerOf);
    }

    // The peer whose pinned key set's fingerprint ends in `tail` (a mirror's path names it so).
    byFingerprintTail(tail: string): Peer | undefined {
        return this.peers().find((peer) => peer.document.fingerprint.endsWith(`:${tail}`));
    }

    pin(sourceId: string, address: string, host: string, document: SandboxIdentity): void {
        this.db
            .prepare(`INSERT INTO peers(sourceId, address, host, document, state) VALUES (?, ?, ?, ?, 'ok') ON CONFLICT(sourceId) DO UPDATE SET address = excluded.address, host = excluded.host, document = excluded.document`)
            .run(sourceId, address, host, JSON.stringify(document));
    }

    hold(sourceId: string, state: Exclude<PeerState, `ok`>, problem: string, evidence?: Evidence): void {
        this.db.prepare(`UPDATE peers SET state = ?, problem = ?, evidence = COALESCE(?, evidence) WHERE sourceId = ?`).run(state, problem, evidence === undefined ? null : JSON.stringify(evidence), sourceId);
    }

    // A person looked and lets it run again: the evidence stays on record until the peer is removed.
    release(sourceId: string): void {
        this.db.prepare(`UPDATE peers SET state = 'ok', problem = NULL WHERE sourceId = ?`).run(sourceId);
    }

    leaves(sourceId: string): Hash[] {
        return this.db
            .prepare(`SELECT leaf FROM peer_entries WHERE sourceId = ? ORDER BY seq`)
            .all(sourceId)
            .map((row) => new Uint8Array(Buffer.from(z.object({ leaf: z.string() }).parse(row).leaf, `hex`)));
    }

    served(sourceId: string, start: number, end: number): ServedEntry[] {
        return this.db
            .prepare(`SELECT seq, leaf, signed FROM peer_entries WHERE sourceId = ? AND seq >= ? AND seq < ? ORDER BY seq`)
            .all(sourceId, start, end)
            .map((raw) => {
                const row = z.object({ seq: z.number(), leaf: z.string(), signed: z.string().nullable() }).parse(raw);
                return row.signed === null ? { seq: row.seq, erased: true as const, leaf: row.leaf } : { seq: row.seq, signed: SignedEntrySchema.parse(JSON.parse(row.signed)) };
            });
    }

    appendVerified(sourceId: string, append: VerifiedAppend, at: number): void {
        for (const { served, leaf } of append.entries) {
            this.db.prepare(`INSERT OR REPLACE INTO peer_entries(sourceId, seq, leaf, signed) VALUES (?, ?, ?, ?)`).run(sourceId, served.seq, toHex(leaf), `signed` in served ? JSON.stringify(served.signed) : null);
        }
        for (const seq of append.withdrawn) {
            this.db.prepare(`UPDATE peer_entries SET signed = NULL WHERE sourceId = ? AND seq = ?`).run(sourceId, seq);
        }
        const size = append.entries.length === 0 ? undefined : (append.entries.at(-1)?.served.seq ?? -1) + 1;
        this.db
            .prepare(`UPDATE peers SET checkpoint = ?, size = COALESCE(?, size), cosigned = cosigned + ?, syncedAt = ?, problem = NULL WHERE sourceId = ?`)
            .run(JSON.stringify(append.checkpoint), size ?? null, append.cosigned, at, sourceId);
    }

    witnessed(sourceId: string, witnessed: readonly Witnessed[]): void {
        this.db.prepare(`UPDATE peers SET witnessed = ? WHERE sourceId = ?`).run(JSON.stringify(witnessed), sourceId);
    }

    catalog(sourceId: string, catalog: string): void {
        this.db.prepare(`UPDATE peers SET catalog = ? WHERE sourceId = ?`).run(catalog, sourceId);
    }

    // As a witness: the last checkpoint cosigned for a log, by its origin.
    witnessState(origin: string): { readonly size: number; readonly root: string; readonly checkpoint: Checkpoint } | undefined {
        const row = this.db.prepare(`SELECT size, root, checkpoint FROM witness_state WHERE origin = ?`).get(origin);
        if (row === undefined) {
            return undefined;
        }
        const parsed = z.object({ size: z.number(), root: z.string(), checkpoint: z.string() }).parse(row);
        return { size: parsed.size, root: parsed.root, checkpoint: CheckpointSchema.parse(JSON.parse(parsed.checkpoint)) };
    }

    witnessCount(): number {
        return z.object({ count: z.number() }).parse(this.db.prepare(`SELECT COUNT(*) AS count FROM witness_state`).get()).count;
    }

    saveWitnessState(origin: string, size: number, root: string, checkpoint: Checkpoint, at: number): void {
        this.db.prepare(`INSERT OR REPLACE INTO witness_state(origin, size, root, checkpoint, at) VALUES (?, ?, ?, ?, ?)`).run(origin, size, root, JSON.stringify(checkpoint), at);
    }
}
