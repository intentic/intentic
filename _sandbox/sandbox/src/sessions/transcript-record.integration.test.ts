import { mkdir, mkdtemp, readdir, readFile, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AgentHarness, type AgentProvider, PROVIDERS, HARNESSES, type TranscriptRow } from "@intentic/sandbox-contract";
import { foldTurn } from "@intentic/sandbox-contract/transcript-fold";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { blobsRoot } from "./record/record-blobs.js";
import { backupFile } from "./record/record-convert.js";
import { BLOB_GRACE_MS, fileTranscriptRecord, legacyTranscriptFile, transcriptFile } from "./transcript-record.js";
import { openingRows } from "./turn-transcript.js";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "transcript-record-"));

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

const said = (text: string): TranscriptRow => ({ role: "assistant", text });

describe("fileTranscriptRecord", () => {
    it("reads back the turns it was given, oldest first, creating the record on the first append", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "two", "second"]);
    });

    it("keeps conversations apart, and answers empty for one it has never seen", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [said("mine")]);
        expect(await record.read("c2")).toEqual([]);
    });

    it("fails a record that exists but cannot be read, rather than answering a conversation with no history", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await mkdir(transcriptFile(root, "c1"), { recursive: true });
        await expect(record.read("c1")).rejects.toThrow(/EISDIR/);
        await expect(record.truncate("c1", 0)).rejects.toThrow(/EISDIR/);
    });

    it("opens a branch with the source's first rows and leaves the source alone", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);

        await record.fork("c2", "c1", 2);
        await record.append("c2", [{ role: "user", text: "two, revised" }, said("redone")]);

        expect((await record.read("c2")).map((message) => message.text)).toEqual(["one", "first", "two, revised", "redone"]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "two", "second"]);
    });

    it("truncates to the rows it keeps, says how many it dropped, and leaves no temp file beside the record", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [{ role: "user", text: "one" }, said("first"), { role: "user", text: "two" }, said("second")]);
        expect(await record.truncate("c1", 2)).toBe(2);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first"]);
        expect(await record.truncate("c1", 2)).toBe(0);
        expect(await readdir(dirname(transcriptFile(root, "c1")))).toEqual(["transcript.jsonl.zst"]);
    });

    it("leaves an already-opened branch alone, so a repeated origin cannot re-copy over its turns", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [said("source")]);
        await record.fork("c2", "c1", 1);
        await record.append("c2", [said("branch's own")]);

        await record.fork("c2", "c1", 1);
        expect((await record.read("c2")).map((message) => message.text)).toEqual(["source", "branch's own"]);
    });

    it("costs a torn final turn its own rows, not the conversation above it", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [said("whole")]);
        await record.append("c1", [said("torn")]);
        // A write the daemon was killed in the middle of.
        await truncate(transcriptFile(root, "c1"), (await stat(transcriptFile(root, "c1"))).size - 5);
        expect((await fileTranscriptRecord(root).read("c1")).map((message) => message.text)).toEqual(["whole"]);
    });

    // The row index is kept across calls and extended over the appended tail; every answer must still be what a fresh
    // read of the file would say.
    it("counts, pages and finds through appends exactly as a fresh read of the record would", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        expect(await record.count("c1")).toBe(2);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);
        expect(await record.count("c1")).toBe(4);
        expect((await record.window("c1", { turns: 1 })).rows.map((message) => message.text)).toEqual(["two", "second"]);
        expect((await record.findBack("c1", (message) => message.text.startsWith("fir")))?.text).toBe("first");
        expect(await fileTranscriptRecord(root).count("c1")).toBe(4);
    });

    it("cuts a torn last turn away, so the next append lands whole instead of joining it", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [said("whole")]);
        await record.append("c1", [said("torn")]);
        await truncate(transcriptFile(root, "c1"), (await stat(transcriptFile(root, "c1"))).size - 5);
        const reopened = fileTranscriptRecord(root);
        expect(await reopened.count("c1")).toBe(1);
        await reopened.append("c1", [said("after")]);
        expect(await reopened.count("c1")).toBe(2);
        expect(await fileTranscriptRecord(root).count("c1")).toBe(2);
        expect((await reopened.read("c1")).map((message) => message.text)).toEqual(["whole", "after"]);
    });

    it("forgets the index a truncate invalidates: the next count reads the shortened record", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [{ role: "user", text: "one" }, said("first"), { role: "user", text: "two" }, said("second")]);
        expect(await record.count("c1")).toBe(4);
        expect(await record.truncate("c1", 2)).toBe(2);
        expect(await record.count("c1")).toBe(2);
        expect((await record.window("c1", {})).rows.map((message) => message.text)).toEqual(["one", "first"]);
    });

    it("reads a record from before the log as it stands, and converts it, backed up, before its first change", async () => {
        const root = await dir();
        const legacy = legacyTranscriptFile(root, "c1");
        await mkdir(dirname(legacy), { recursive: true });
        const rows = [{ role: "user", text: "one" }, said("first")];
        await writeFile(legacy, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        const record = fileTranscriptRecord(root);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first"]);
        expect((await record.window("c1", {})).rows.map((message) => message.text)).toEqual(["one", "first"]);
        await record.append("c1", [said("second")]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "second"]);
        expect(await readdir(dirname(legacy))).toEqual(["transcript.jsonl.zst"]);
        expect(await readZstd(backupFile(root, "c1"))).toBe(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    });

    it("keeps a long output whole through a fork, stored once for both conversations", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        const dump = "0123456789".repeat(5_000);
        const tooled: TranscriptRow = {
            role: "assistant",
            text: "ran it",
            tools: [{ id: "t1", name: "Bash", category: "execute", status: "completed", target: "cat big", content: [{ type: "text", text: dump }] }],
        };
        await record.append("c1", [{ role: "user", text: "go" }, tooled]);
        await record.fork("c2", "c1", 2);
        for (const id of ["c1", "c2"]) {
            expect((await record.read(id))[1]?.tools?.[0]?.content).toEqual([{ type: "text", text: dump }]);
        }
        const shards = await readdir(blobsRoot(root));
        expect((await Promise.all(shards.map((shard) => readdir(join(blobsRoot(root), shard))))).flat()).toHaveLength(1);
    });

    it("sweeps the blobs only a gone record named, and every output another record names stays whole", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        const ran = (dump: string): TranscriptRow => ({
            role: "assistant",
            text: "ran it",
            tools: [{ id: "t1", name: "Bash", category: "execute", status: "completed", target: "cat", content: [{ type: "text", text: dump }] }],
        });
        const shared = "s".repeat(20_000);
        const kept = [ran(shared), ran("k".repeat(20_000))];
        await record.append("gone-1", [ran(shared), ran("g".repeat(20_000))]);
        await record.append("kept-1", kept);
        const blobs = async (): Promise<string[]> => (await readdir(blobsRoot(root), { recursive: true })).filter((name) => name.endsWith(".zst"));
        // Named within the grace, so nothing is judged yet.
        expect(await record.sweep(new Set(["gone-1"]))).toBe(0);
        const past = new Date(Date.now() - 2 * BLOB_GRACE_MS);
        await Promise.all((await blobs()).map((name) => utimes(join(blobsRoot(root), name), past, past)));

        expect(await record.sweep(new Set(["gone-1"]))).toBe(1);
        expect(await blobs()).toHaveLength(2);
        expect(await record.read("kept-1")).toEqual(kept);
    });

    it("ignores an id that is not filename-safe rather than letting it reach a path", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("../escape", [said("nope")]);
        expect(await record.read("../escape")).toEqual([]);
    });
});

// Drives every provider×harness pair (read from the PROVIDERS/HARNESSES catalog, not a hardcoded list) through the fold
// the daemon runs live, and demands a readable transcript out the other end.
describe("every provider records a readable transcript", () => {
    const turn = { prompt: "do the thing", messageId: "m-1" };
    const events: AgentEvent[] = [
        { kind: "delta", text: "on it" },
        { kind: "text_end" },
        { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
        { kind: "tool_call_update", id: "t1", status: "completed", content: [{ type: "text", text: "1 passed" }] },
    ];

    const pairs: { provider: AgentProvider; harness: AgentHarness }[] = PROVIDERS.flatMap((provider) =>
        HARNESSES.map((harness) => ({ provider: provider.value as AgentProvider, harness: harness.value })),
    );

    it.each(pairs)("$provider on the $harness harness", async ({ provider, harness }) => {
        const record = fileTranscriptRecord(await dir());
        const id = `${provider}-${harness}`;
        await record.append(id, foldTurn(openingRows(turn, WORKSPACE_ROOT, 1_767_225_600_000), events));
        const restored = await record.read(id);
        // The id rides the record too: after a restart it is what a rewind and a resent message are recognised by.
        expect(restored[0]).toEqual({ role: "user", text: "do the thing", sentAt: 1_767_225_600_000, messageId: "m-1" });
        expect(restored.map((message) => message.text)).toContain("on it");
        expect(restored.flatMap((message) => message.tools ?? [])).toEqual([
            { id: "t1", name: "Bash", category: "execute", status: "completed", target: "pnpm test", content: [{ type: "text", text: "1 passed" }] },
        ]);
    });
});
