import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import pino from "pino";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { fileTranscriptRecord, legacyTranscriptFile, transcriptFile } from "../transcript-record.js";
import { blobsRoot, putBlob } from "./record-blobs.js";
import { backupFile, convertLegacy } from "./record-convert.js";
import { type MigrationDeps, migrateOnThreads, migrateRecords, preparedFile } from "./record-migration.js";

// The pass that converts plain records against real files and real worker threads: every record read back as it was,
// its original kept, the phrase index's pin moved only where it stood on the record converted, and a record that
// changed or failed midway left as it is.

const exec = promisify(execFile);
const readZstd = async (path: string): Promise<string> => {
    try {
        return (await exec("zstdcat", [path])).stdout;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return zstdDecompressSync(await readFile(path)).toString("utf8");
        }
        throw error;
    }
};
const logger = pino({ level: "silent" });

let historyRoot: string;
beforeEach(async () => {
    historyRoot = await mkdtemp(join(tmpdir(), "intentic-record-migration-"));
});
afterEach(async () => {
    await rm(historyRoot, { recursive: true, force: true });
});

const rowsOf = (id: string): TranscriptRow[] => [
    { role: "user", text: `ask ${id}` },
    {
        role: "assistant",
        text: `answer ${id}`,
        tools: [{ id: "t1", name: "Bash", category: "execute", status: "completed", target: "ls", content: [{ type: "text", text: `${id} `.repeat(10_000) }] }],
    },
];

const jsonl = (rows: readonly TranscriptRow[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const plain = async (id: string): Promise<string> => {
    const legacy = legacyTranscriptFile(historyRoot, id);
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, jsonl(rowsOf(id)));
    return legacy;
};

const pins = (): { readonly deps: Pick<MigrationDeps, "indexed" | "repin">; readonly moved: Map<string, string> } => {
    const moved = new Map<string, string>();
    return {
        moved,
        deps: {
            indexed: async () => new Map([["pinned-one", String(jsonl(rowsOf("pinned-one")).length)]]),
            repin: async (id, version) => {
                moved.set(id, version);
            },
        },
    };
};

test("converts every plain record on worker threads, keeps each original and moves only the pins that stood on it", async () => {
    await plain("pinned-one");
    await plain("unpinned-two");
    // A crashed pass's leftover beside a record a turn has since converted.
    await mkdir(dirname(preparedFile(historyRoot, "left-three")), { recursive: true });
    await writeFile(preparedFile(historyRoot, "left-three"), "half a log");
    const record = fileTranscriptRecord(historyRoot);
    const { deps, moved } = pins();

    const report = await migrateOnThreads({ historyRoot, adopt: record.adopt, logger, ...deps });

    expect(report).toMatchObject({ converted: 2, failed: 0, legacyBytes: jsonl(rowsOf("pinned-one")).length + jsonl(rowsOf("unpinned-two")).length });
    for (const id of ["pinned-one", "unpinned-two"]) {
        expect(await readdir(dirname(transcriptFile(historyRoot, id)))).toEqual(["transcript.jsonl.zst"]);
        expect(await record.read(id)).toEqual(rowsOf(id));
        expect(await readZstd(backupFile(historyRoot, id))).toBe(jsonl(rowsOf(id)));
    }
    expect(await readdir(dirname(preparedFile(historyRoot, "left-three")))).toEqual([]);
    // The long outputs moved out of line, once each.
    expect((await readdir(blobsRoot(historyRoot), { recursive: true })).filter((name) => name.endsWith(".zst"))).toHaveLength(2);
    expect([...moved]).toEqual([["pinned-one", String((await stat(transcriptFile(historyRoot, "pinned-one"))).size)]]);
    expect(report.logBytes).toBe((await stat(transcriptFile(historyRoot, "pinned-one"))).size + (await stat(transcriptFile(historyRoot, "unpinned-two"))).size);

    // A second pass finds nothing left to do.
    expect(await migrateOnThreads({ historyRoot, adopt: record.adopt, logger, ...deps })).toEqual({ converted: 0, failed: 0, legacyBytes: 0, logBytes: 0 });
});

test("a record that changed after its conversion is not adopted, and one that fails stays plain and readable", async () => {
    const changed = await plain("changed-one");
    await plain("failing-two");
    const record = fileTranscriptRecord(historyRoot);
    const { deps, moved } = pins();

    const report = await migrateRecords({
        historyRoot,
        adopt: record.adopt,
        logger,
        ...deps,
        convert: async (ask) => {
            if (ask.conversationId === "failing-two") {
                throw new Error("disk full");
            }
            const converted = await convertLegacy({ historyRoot, conversationId: ask.conversationId, legacy: ask.legacy, target: ask.prepared, put: (text) => putBlob(historyRoot, text) });
            await appendFile(changed, `${JSON.stringify({ role: "user", text: "one more" })}\n`);
            return converted;
        },
    });

    expect(report).toMatchObject({ converted: 0, failed: 1 });
    expect(await readdir(dirname(changed))).toEqual(["transcript.jsonl"]);
    expect(await readdir(dirname(legacyTranscriptFile(historyRoot, "failing-two")))).toEqual(["transcript.jsonl"]);
    expect(await record.read("failing-two")).toEqual(rowsOf("failing-two"));
    expect((await record.read("changed-one")).at(-1)).toEqual({ role: "user", text: "one more" });
    expect(moved.size).toBe(0);
});

test("a turn that changes a record the pass has not reached converts it first, and the pass then leaves it be", async () => {
    await plain("busy-one");
    const record = fileTranscriptRecord(historyRoot);
    await record.append("busy-one", [{ role: "user", text: "next" }]);
    expect(await readdir(dirname(transcriptFile(historyRoot, "busy-one")))).toEqual(["transcript.jsonl.zst"]);
    expect(await migrateOnThreads({ historyRoot, adopt: record.adopt, logger, ...pins().deps })).toMatchObject({ converted: 0, failed: 0 });
    expect(await record.read("busy-one")).toEqual([...rowsOf("busy-one"), { role: "user", text: "next" }]);
});
