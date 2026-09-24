import { readdir, rm, stat } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { join } from "node:path";
import type { Logger } from "pino";
import { isConversationId } from "@intentic/sandbox-contract";
import { conversationsRoot, conversationUnit } from "../../store/conversation-units.js";
import { siblingModule, workerPool } from "../../workers/worker-calls.js";
import { type FileTranscriptRecord, legacyTranscriptFile, transcriptFile } from "../transcript-record.js";
import type { Converted } from "./record-convert.js";

// Every record still in the plain JSONL format converted to the log in one pass behind boot, newest first, each on a
// worker thread (record-migration-worker.ts) and adopted under the record's own lock only if it is still the record
// that was converted. A record that fails stays plain, read as it is, and converts when a turn next changes it.

// Beside the log it becomes; the migration is its only writer, so one found when a pass begins is a crash's leftover.
export const preparedFile = (historyRoot: string, conversationId: string): string => `${transcriptFile(historyRoot, conversationId)}.migrating`;

// Conversions at once, each a thread parsing and compressing: more would take the cores a running turn is using.
const LANES = 2;

export interface ConvertAsk {
    readonly conversationId: string;
    readonly legacy: string;
    readonly prepared: string;
}

export interface MigrationDeps {
    readonly historyRoot: string;
    readonly adopt: FileTranscriptRecord["adopt"];
    // Writes one record's log to `prepared` and its backup, answering what it converted; undefined when it is gone.
    readonly convert: (ask: ConvertAsk) => Promise<Converted | undefined>;
    // What the phrase index pins each conversation to (its record's size), and a move of one pin to a new size: the
    // conversion keeps every spoken line, so re-reading them would only spend the index's time.
    readonly indexed: () => Promise<ReadonlyMap<string, string>>;
    readonly repin: (conversationId: string, version: string) => Promise<void>;
    readonly logger: Logger;
}

export interface MigrationReport {
    readonly converted: number;
    readonly failed: number;
    // Bytes of the plain records converted, and of the logs they became.
    readonly legacyBytes: number;
    readonly logBytes: number;
}

interface Plain {
    readonly conversationId: string;
    readonly legacy: string;
    readonly size: number;
    readonly mtimeMs: number;
}

const LEGACY_NAME = "transcript.jsonl";
const PREPARED_NAME = `${LEGACY_NAME}.zst.migrating`;

// The conversations with a plain record, newest first, each unit's leftover from a crashed pass removed on the way.
const plainRecords = async (historyRoot: string): Promise<Plain[]> => {
    const found: Plain[] = [];
    for (const entry of (await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) {
        if (!entry.isDirectory() || !isConversationId(entry.name)) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one directory at a time keeps the pass off the shared I/O pool.
        const names = await readdir(conversationUnit(historyRoot, entry.name)).catch((): string[] => []);
        if (names.includes(PREPARED_NAME)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
            await rm(join(conversationUnit(historyRoot, entry.name), PREPARED_NAME), { force: true });
        }
        if (!names.includes(LEGACY_NAME)) {
            continue;
        }
        const legacy = legacyTranscriptFile(historyRoot, entry.name);
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        const info = await stat(legacy).catch(undefinedIfMissing);
        if (info !== undefined) {
            found.push({ conversationId: entry.name, legacy, size: info.size, mtimeMs: info.mtimeMs });
        }
    }
    return found.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
};

export const migrateRecords = async (deps: MigrationDeps, signal?: AbortSignal): Promise<MigrationReport> => {
    const { historyRoot, logger } = deps;
    const records = await plainRecords(historyRoot);
    if (records.length === 0) {
        return { converted: 0, failed: 0, legacyBytes: 0, logBytes: 0 };
    }
    const started = Date.now();
    logger.info({ records: records.length, bytes: records.reduce((total, record) => total + record.size, 0) }, "records: converting plain records to the log");
    const indexed = await deps.indexed();
    let next = 0;
    let converted = 0;
    let failed = 0;
    let legacyBytes = 0;
    let logBytes = 0;
    const one = async ({ conversationId, legacy }: Plain): Promise<void> => {
        const prepared = preparedFile(historyRoot, conversationId);
        try {
            const done = await deps.convert({ conversationId, legacy, prepared });
            // Gone, or converted by a turn that changed it meanwhile: either way the record is already a log.
            const size = done === undefined ? undefined : await deps.adopt(conversationId, prepared, done);
            if (done === undefined || size === undefined) {
                return;
            }
            converted += 1;
            legacyBytes += done.size;
            logBytes += size;
            if (indexed.get(conversationId) === String(done.size)) {
                await deps.repin(conversationId, String(size));
            }
        } catch (error) {
            failed += 1;
            logger.warn({ err: error, conversationId }, "records: a record stays plain until a turn changes it");
            await rm(prepared, { force: true });
        }
    };
    const lane = async (): Promise<void> => {
        for (let record = records[next]; record !== undefined; record = records[next]) {
            if (signal?.aborted === true) {
                return;
            }
            next += 1;
            // oxlint-disable-next-line eslint/no-await-in-loop -- a lane converts one record at a time.
            await one(record);
        }
    };
    await Promise.all(Array.from({ length: LANES }, lane));
    const report = { converted, failed, legacyBytes, logBytes };
    logger.info({ ...report, left: records.length - converted - failed, ms: Date.now() - started }, "records: converted plain records to the log");
    return report;
};

// The pass as the daemon runs it: every conversion on worker threads, let go once the pass ends.
export const migrateOnThreads = async (deps: Omit<MigrationDeps, "convert">, signal?: AbortSignal): Promise<MigrationReport> => {
    const threads = workerPool<ConvertAsk>(siblingModule(import.meta, "record-migration-worker"), { historyRoot: deps.historyRoot }, LANES);
    try {
        return await migrateRecords({ ...deps, convert: (ask) => threads.call<Converted | undefined>(ask) }, signal);
    } finally {
        await threads.close();
    }
};
