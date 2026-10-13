import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import {
    type AuditEvent,
    type AuditExport,
    type AuditList,
    type AuditQuery,
    type AuditRecord,
    AuditRecordSchema,
    type AuditVerify,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { checkChain, GENESIS_HASH, sealRecord, type SegmentText } from "./audit-chain.js";

// The audit trail on disk (historyRoot/audit/): one JSON Lines file per calendar month (UTC) under `segments/`, each
// line a record carrying the hash of the one before it, and a checkpoint naming the last record retention deleted, so
// the chain still checks out from the first record kept. The daemon is its only writer: appends queue behind each other
// here, each one synced to disk before the next is hashed onto it.
// Records are never converted the way other stored documents are: a converted record would no longer match its hash.
// A later build that needs more adds fields under a new `v`, and the verifier hashes whatever a line holds.

export const AUDIT_DIR = "audit";
const SEGMENTS_DIR = "segments";
const SEGMENT_SUFFIX = ".jsonl";
const DAY_MS = 86_400_000;

const AuditCheckpointSchema = z.object({
    // The month file the last pruned record was in; files up to it are deleted or about to be.
    segment: z.string(),
    at: z.number(),
    hash: z.string(),
    prunedAt: z.number(),
});

// Written before the month file it describes is deleted, so a crash between the two leaves a file the verifier skips,
// never a chain that starts nowhere.
export const auditCheckpointDocument = defineDocument({ root: "history", path: "audit/checkpoint.json", schema: AuditCheckpointSchema });

export interface AuditLog {
    // Queues one record; never throws and never waits for the disk. What could not be written is logged, not raised:
    // an audit write must not fail the request that caused it.
    readonly record: (event: AuditEvent) => void;
    // Resolves once every record queued so far is on disk.
    readonly flush: () => Promise<void>;
    readonly list: (query: AuditQuery) => Promise<AuditList>;
    readonly verify: () => Promise<AuditVerify>;
    readonly exportRange: (from: number, to: number) => Promise<AuditExport>;
    // Records written after `at`, oldest first, at most `limit`: what the forwarder sends next.
    readonly after: (at: number, limit: number) => Promise<readonly StoredRecord[]>;
    readonly newestAt: () => Promise<number | undefined>;
    readonly oldestAt: () => Promise<number | undefined>;
    readonly segments: () => Promise<string[]>;
    // Deletes every month file wholly older than `days`, except the current month's; answers the files deleted.
    readonly prune: (days: number, now?: number) => Promise<string[]>;
    // Called after each record reaches the disk (the forwarder's kick).
    readonly onAppend: (listener: (record: AuditRecord) => void) => void;
}

const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);
const segmentFile = (month: string): string => `${month}${SEGMENT_SUFFIX}`;

interface Span {
    readonly start: number;
    readonly end: number;
}

// The first and the end (exclusive) of a month file's span, in milliseconds.
const monthSpan = (segment: string): Span => {
    const [year = 1970, month = 1] = segment.slice(0, 7).split("-").map(Number);
    return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) };
};

const parseRecord = (line: string): AuditRecord | undefined => {
    try {
        return AuditRecordSchema.safeParse(JSON.parse(line)).data;
    } catch {
        // allow(silent-catch): a line that is not a record is listed as nothing; /audit/verify is where it is reported
        return undefined;
    }
};

interface StoredRecord {
    readonly record: AuditRecord;
    // The line exactly as stored, which is what an export and the forwarder send, so the hash still checks out.
    readonly line: string;
}

const recordsOf = (text: string): StoredRecord[] =>
    text.split("\n").flatMap((line) => {
        const record = line === "" ? undefined : parseRecord(line);
        return record === undefined ? [] : [{ record, line }];
    });

const lowered = (value: string | undefined): string => value?.toLowerCase() ?? "";

const actorText = (record: AuditRecord): string => {
    const { actor } = record;
    switch (actor.kind) {
        case "member": {
            return actor.email;
        }
        case "token": {
            return `${actor.label} ${actor.id}`;
        }
        case "agent": {
            return actor.conversationId;
        }
        default: {
            return `system ${actor.reason ?? ""}`;
        }
    }
};

const matches = (query: AuditQuery, record: AuditRecord): boolean =>
    (query.from === undefined || record.at >= query.from) &&
    (query.to === undefined || record.at < query.to) &&
    (query.before === undefined || record.at < query.before) &&
    (query.action === undefined || record.action.startsWith(query.action)) &&
    (query.actor === undefined || lowered(actorText(record)).includes(query.actor.toLowerCase())) &&
    (query.target === undefined || lowered(record.target).includes(query.target.toLowerCase()));

type Checkpoint = z.infer<typeof AuditCheckpointSchema>;

// The files of one trail: its month files and its checkpoint.
interface Disk {
    readonly dir: string;
    readonly checkpoint: JsonFile<Checkpoint | undefined>;
}

interface Kept {
    readonly names: string[];
    readonly start: string;
    readonly checkpoint: Checkpoint | undefined;
}

const allSegments = async (disk: Disk): Promise<string[]> => {
    const names = (await readdir(disk.dir).catch(undefinedIfMissing)) ?? [];
    return names.filter((name) => /^\d{4}-\d{2}\.jsonl$/u.test(name)).toSorted();
};

const readSegment = async (disk: Disk, name: string): Promise<string> =>
    (await readFile(join(disk.dir, name), "utf8").catch(undefinedIfMissing)) ?? "";

// The month files the chain runs through: those after the checkpoint's, which retention deleted or is deleting.
const keptOf = async (disk: Disk): Promise<Kept> => {
    const checkpoint = await disk.checkpoint.read();
    const names = (await allSegments(disk)).filter((name) => checkpoint === undefined || name > checkpoint.segment);
    return { names, start: checkpoint?.hash ?? GENESIS_HASH, checkpoint };
};

const lastRecord = async (disk: Disk, names: readonly string[]): Promise<AuditRecord | undefined> => {
    for (const name of names.toReversed()) {
        const last = recordsOf(await readSegment(disk, name)).at(-1);
        if (last !== undefined) {
            return last.record;
        }
    }
    return undefined;
};

interface Head {
    hash: string;
    at: number;
    // Bytes of a torn last line cut off before the first append, to be recorded with it.
    torn: number;
}

// The chain's head, found once from the disk, then carried by each append. A torn last line (a crash mid-write) is cut
// off first, since the next line would otherwise be glued onto it. A broken chain is not repaired by writing past it:
// new records link to the last record on disk, so the break stays where it is for /audit/verify to name.
const findHead = async (disk: Disk): Promise<Head> => {
    const { names, start, checkpoint } = await keptOf(disk);
    const newest = names.at(-1);
    let torn = 0;
    if (newest !== undefined) {
        const text = await readSegment(disk, newest);
        const cut = text.lastIndexOf("\n") + 1;
        if (cut < text.length) {
            torn = Buffer.byteLength(text.slice(cut));
            await truncate(join(disk.dir, newest), Buffer.byteLength(text.slice(0, cut)));
        }
    }
    const last = await lastRecord(disk, names);
    return { hash: last?.hash ?? start, at: last?.at ?? checkpoint?.at ?? 0, torn };
};

const appendLine = async (disk: Disk, record: AuditRecord): Promise<void> => {
    await mkdir(disk.dir, { recursive: true });
    const handle = await open(join(disk.dir, segmentFile(monthOf(record.at))), "a", 0o600);
    try {
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.datasync();
    } finally {
        await handle.close();
    }
};

// Appends `event` after `head`, preceded by a note of a torn line cut off, and answers what was written.
const writeEvent = async (disk: Disk, head: Head, event: AuditEvent): Promise<AuditRecord[]> => {
    const events: AuditEvent[] = [];
    if (head.torn > 0) {
        events.push({ actor: { kind: "system", reason: "audit" }, action: "audit.torn_write_dropped", details: { bytes: head.torn } });
        head.torn = 0;
    }
    events.push(event);
    const written: AuditRecord[] = [];
    for (const next of events) {
        // Strictly increasing, so `at` alone orders the trail and pages it.
        const at = Math.max(Date.now(), head.at + 1);
        const record = sealRecord({ ...next, v: 1, id: randomUUID(), at, prevHash: head.hash });
        await appendLine(disk, record);
        head.hash = record.hash;
        head.at = at;
        written.push(record);
    }
    return written;
};

const listRecords = async (disk: Disk, query: AuditQuery): Promise<AuditList> => {
    const found: AuditRecord[] = [];
    const upper = Math.min(query.to ?? Number.POSITIVE_INFINITY, query.before ?? Number.POSITIVE_INFINITY);
    const from = query.from ?? Number.NEGATIVE_INFINITY;
    for (const name of (await keptOf(disk)).names.toReversed()) {
        const span = monthSpan(name);
        if (span.end <= from) {
            break;
        }
        if (span.start < upper) {
            const hits = recordsOf(await readSegment(disk, name)).flatMap(({ record }) => (matches(query, record) ? [record] : []));
            found.push(...hits.toReversed());
        }
        if (found.length > query.limit) {
            break;
        }
    }
    const records = found.slice(0, query.limit);
    const last = records.at(-1);
    return found.length > query.limit && last !== undefined ? { records, next: last.at } : { records };
};

const verifyChain = async (disk: Disk): Promise<AuditVerify> => {
    const { names, start, checkpoint } = await keptOf(disk);
    const texts: SegmentText[] = await Promise.all(names.map(async (name) => ({ name, text: await readSegment(disk, name) })));
    const chain = checkChain(texts, start);
    const verdict: AuditVerify = { ok: chain.broken === undefined, checked: chain.checked, segments: names.length, torn: chain.torn };
    if (checkpoint !== undefined) {
        verdict.prunedThrough = { at: checkpoint.at, hash: checkpoint.hash };
    }
    if (chain.broken !== undefined) {
        verdict.broken = chain.broken;
    }
    return verdict;
};

// Stored records in [from, to), oldest first, from the month files that overlap it.
const recordsBetween = async (disk: Disk, from: number, to: number): Promise<StoredRecord[]> => {
    const out: StoredRecord[] = [];
    for (const name of (await keptOf(disk)).names) {
        const span = monthSpan(name);
        if (span.end > from && span.start < to) {
            out.push(...recordsOf(await readSegment(disk, name)).filter(({ record }) => record.at >= from && record.at < to));
        }
    }
    return out;
};

// The UTC calendar day, as the month files are cut by UTC month too.
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

const exportRange = async (disk: Disk, from: number, to: number): Promise<AuditExport> => {
    const lines = (await recordsBetween(disk, from, to)).map(({ line }) => line);
    return {
        filename: `audit-${utcDay(from)}-to-${utcDay(Math.max(from, to - 1))}.jsonl`,
        jsonl: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
        count: lines.length,
    };
};

const recordsAfter = async (disk: Disk, at: number, limit: number): Promise<StoredRecord[]> => {
    const out: StoredRecord[] = [];
    for (const name of (await keptOf(disk)).names) {
        if (monthSpan(name).end > at) {
            out.push(...recordsOf(await readSegment(disk, name)).filter(({ record }) => record.at > at));
        }
        if (out.length >= limit) {
            break;
        }
    }
    return out.slice(0, limit);
};

const oldestAt = async (disk: Disk): Promise<number | undefined> => {
    for (const name of (await keptOf(disk)).names) {
        const first = recordsOf(await readSegment(disk, name)).at(0);
        if (first !== undefined) {
            return first.record.at;
        }
    }
    return undefined;
};

// Deletes the month files wholly older than `days`, never the current month's, oldest first, each after the checkpoint
// has moved past its last record.
const pruneSegments = async (disk: Disk, days: number, now: number): Promise<string[]> => {
    const cutoff = now - days * DAY_MS;
    const current = segmentFile(monthOf(now));
    const deleted: string[] = [];
    for (const name of (await keptOf(disk)).names) {
        if (name >= current || monthSpan(name).end > cutoff) {
            break;
        }
        const last = recordsOf(await readSegment(disk, name)).at(-1)?.record;
        if (last !== undefined) {
            await disk.checkpoint.update(() => ({ segment: name, at: last.at, hash: last.hash, prunedAt: now }));
        }
        await unlink(join(disk.dir, name)).catch(undefinedIfMissing);
        deleted.push(name);
    }
    return deleted;
};

export const fileAuditLog = (historyRoot: string, warn: (message: string, error: Error) => void): AuditLog => {
    const disk: Disk = {
        dir: join(historyRoot, AUDIT_DIR, SEGMENTS_DIR),
        checkpoint: openDocument<typeof auditCheckpointDocument, Checkpoint | undefined>(
            auditCheckpointDocument,
            join(historyRoot, auditCheckpointDocument.path),
            { fallback: () => undefined, read: (value) => value },
        ),
    };
    const listeners: ((record: AuditRecord) => void)[] = [];
    let head: Promise<Head> | undefined;
    // Every write and every prune queue here, one at a time: a hash is computed on the head the previous write left.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
        const run = queue.then(work);
        queue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    };
    const write = async (event: AuditEvent): Promise<void> => {
        head ??= findHead(disk);
        for (const record of await writeEvent(disk, await head, event)) {
            for (const listener of listeners) {
                listener(record);
            }
        }
    };
    return {
        record: (event) => {
            enqueue(() => write(event)).catch((error: Error) => {
                // Read again from the disk next time: what this write left there is the truth.
                head = undefined;
                warn(`audit: could not write a ${event.action} record`, error);
            });
        },
        flush: () => enqueue(() => Promise.resolve()),
        list: (query) => listRecords(disk, query),
        verify: () => verifyChain(disk),
        exportRange: (from, to) => exportRange(disk, from, to),
        after: (at, limit) => recordsAfter(disk, at, limit),
        newestAt: async () => (await lastRecord(disk, (await keptOf(disk)).names))?.at,
        oldestAt: () => oldestAt(disk),
        segments: async () => (await keptOf(disk)).names,
        prune: (days, now = Date.now()) => enqueue(() => pruneSegments(disk, days, now)),
        onAppend: (listener) => {
            listeners.push(listener);
        },
    };
};
