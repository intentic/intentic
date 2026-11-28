import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { type Checkpoint, CheckpointSchema } from "../log/checkpoint.js";
import { type ServedEntry, type SignedEntry, SignedEntrySchema } from "../log/entry.js";
import { consistencyProof, type Hash, inclusionProof, toHex } from "../log/merkle.js";
import { RecordSchema, type NetworkRecord } from "./records.js";

/* THIS SANDBOX'S OWN LOG ON DISK (migration 2 of store.ts): each signed entry with its leaf hash, the payload of a
   withdrawn one erased and its leaf kept; every checkpoint signed so far; and the drafts waiting for a person's yes in the
   approvals queue, keyed by the queue item's id. */

type Row = Record<string, SQLOutputValue>;

export type DraftKind = `publish` | `withdraw`;
export type CosignMode = `offered` | `required`;

export interface Draft {
    readonly id: string;
    readonly kind: DraftKind;
    readonly digest: string;
    readonly record?: NetworkRecord | undefined;
    readonly target?: number | undefined;
    readonly cosign: CosignMode;
    readonly createdAt: number;
    readonly doneSeq?: number | undefined;
}

const DraftRowSchema = z.object({
    id: z.string(),
    kind: z.enum([`publish`, `withdraw`]),
    digest: z.string(),
    record: z.string().nullable(),
    target: z.number().nullable(),
    cosign: z.enum([`offered`, `required`]),
    createdAt: z.number(),
    doneSeq: z.number().nullable(),
});

const draftOf = (raw: Row): Draft => {
    const row = DraftRowSchema.parse(raw);
    return {
        id: row.id,
        kind: row.kind,
        digest: row.digest,
        record: row.record === null ? undefined : RecordSchema.parse(JSON.parse(row.record)),
        target: row.target ?? undefined,
        cosign: row.cosign,
        createdAt: row.createdAt,
        doneSeq: row.doneSeq ?? undefined,
    };
};

const EntryRowSchema = z.object({ seq: z.number(), leaf: z.string(), signed: z.string().nullable() });

// One row of the Published tab: what an entry is, without its whole record.
export interface PublishedRow {
    readonly seq: number;
    readonly type: string | null;
    readonly headline: string | null;
    readonly publishedAt: string;
    readonly tombstoneOf: number | null;
    readonly withdrawn: boolean;
    readonly cosigned: boolean;
}

const PublishedRowSchema = z.object({
    seq: z.number(),
    type: z.string().nullable(),
    headline: z.string().nullable(),
    publishedAt: z.string(),
    tombstoneOf: z.number().nullable(),
    signed: z.string().nullable(),
    cosigned: z.number(),
});

export class LogStore {
    constructor(private readonly db: DatabaseSync) {}

    size(): number {
        return z.object({ size: z.number() }).parse(this.db.prepare(`SELECT COUNT(*) AS size FROM log_entries`).get()).size;
    }

    leaves(size = this.size()): Hash[] {
        return this.db
            .prepare(`SELECT leaf FROM log_entries WHERE seq < ? ORDER BY seq`)
            .all(size)
            .map((row) => new Uint8Array(Buffer.from(z.object({ leaf: z.string() }).parse(row).leaf, `hex`)));
    }

    append(signed: SignedEntry, leaf: Hash): void {
        const { entry } = signed;
        this.db
            .prepare(`INSERT INTO log_entries(seq, leaf, signed, type, headline, publishedAt, tombstoneOf, cosigned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(entry.seq, toHex(leaf), JSON.stringify(signed), entry.record?.[`@type`] ?? null, entry.record?.headline ?? null, entry.publishedAt, entry.tombstoneOf ?? null, Number(entry.cosign !== undefined));
        if (entry.tombstoneOf !== undefined) {
            // The withdrawn record leaves the disk; its leaf stays, so the tree still verifies.
            this.db.prepare(`UPDATE log_entries SET signed = NULL, headline = NULL WHERE seq = ?`).run(entry.tombstoneOf);
        }
    }

    entry(seq: number): SignedEntry | undefined {
        const row = this.db.prepare(`SELECT signed FROM log_entries WHERE seq = ?`).get(seq);
        const signed = row === undefined ? null : z.object({ signed: z.string().nullable() }).parse(row).signed;
        return signed === null ? undefined : SignedEntrySchema.parse(JSON.parse(signed));
    }

    served(start: number, end: number): ServedEntry[] {
        return this.db
            .prepare(`SELECT seq, leaf, signed FROM log_entries WHERE seq >= ? AND seq < ? ORDER BY seq`)
            .all(start, end)
            .map((raw) => {
                const row = EntryRowSchema.parse(raw);
                return row.signed === null ? { seq: row.seq, erased: true as const, leaf: row.leaf } : { seq: row.seq, signed: SignedEntrySchema.parse(JSON.parse(row.signed)) };
            });
    }

    published(limit: number): PublishedRow[] {
        return this.db
            .prepare(`SELECT seq, type, headline, publishedAt, tombstoneOf, signed, cosigned FROM log_entries ORDER BY seq DESC LIMIT ?`)
            .all(limit)
            .map((raw) => {
                const row = PublishedRowSchema.parse(raw);
                return { seq: row.seq, type: row.type, headline: row.headline, publishedAt: row.publishedAt, tombstoneOf: row.tombstoneOf, withdrawn: row.signed === null, cosigned: row.cosigned === 1 };
            });
    }

    // Counts of live records by schema.org type, for the catalog.
    typeCounts(): Record<string, number> {
        const rows = this.db.prepare(`SELECT type, COUNT(*) AS count FROM log_entries WHERE signed IS NOT NULL AND type IS NOT NULL GROUP BY type`).all();
        return Object.fromEntries(rows.map((raw) => {
            const row = z.object({ type: z.string(), count: z.number() }).parse(raw);
            return [row.type, row.count];
        }));
    }

    saveCheckpoint(size: number, checkpoint: Checkpoint, at: number): void {
        this.db.prepare(`INSERT OR REPLACE INTO log_checkpoints(size, checkpoint, signedAt) VALUES (?, ?, ?)`).run(size, JSON.stringify(checkpoint), at);
    }

    checkpoint(): Checkpoint | undefined {
        const row = this.db.prepare(`SELECT checkpoint FROM log_checkpoints ORDER BY size DESC LIMIT 1`).get();
        return row === undefined ? undefined : CheckpointSchema.parse(JSON.parse(z.object({ checkpoint: z.string() }).parse(row).checkpoint));
    }

    inclusion(index: number, size: number): Hash[] {
        return inclusionProof(index, this.leaves(size));
    }

    consistency(from: number, to: number): Hash[] {
        return consistencyProof(from, this.leaves(to));
    }

    saveDraft(draft: Draft): void {
        this.db
            .prepare(`INSERT INTO log_drafts(id, kind, digest, record, target, cosign, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(draft.id, draft.kind, draft.digest, draft.record === undefined ? null : JSON.stringify(draft.record), draft.target ?? null, draft.cosign, draft.createdAt);
    }

    draft(id: string): Draft | undefined {
        const row = this.db.prepare(`SELECT * FROM log_drafts WHERE id = ?`).get(id);
        return row === undefined ? undefined : draftOf(row);
    }

    drafts(): Draft[] {
        return this.db.prepare(`SELECT * FROM log_drafts WHERE doneSeq IS NULL ORDER BY createdAt DESC LIMIT 100`).all().map(draftOf);
    }

    markDone(id: string, seq: number): void {
        this.db.prepare(`UPDATE log_drafts SET doneSeq = ? WHERE id = ?`).run(seq, id);
    }
}
