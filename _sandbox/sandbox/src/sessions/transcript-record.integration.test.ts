import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AgentHarness, type AgentProvider, PROVIDERS, HARNESSES, type TranscriptRow } from "@intentic/sandbox-contract";
import { foldTurn } from "@intentic/sandbox-contract/transcript-fold";
import { fileTranscriptRecord, transcriptFile } from "./transcript-record.js";
import { openingRows } from "./turn-transcript.js";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "transcript-record-"));

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
        expect(await readdir(dirname(transcriptFile(root, "c1")))).toEqual(["transcript.jsonl"]);
    });

    it("leaves an already-opened branch alone, so a repeated origin cannot re-copy over its turns", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [said("source")]);
        await record.fork("c2", "c1", 1);
        await record.append("c2", [said("branch's own")]);

        await record.fork("c2", "c1", 1);
        expect((await record.read("c2")).map((message) => message.text)).toEqual(["source", "branch's own"]);
    });

    it("costs a torn final line its own row, not the conversation above it", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [said("whole")]);
        // A write the daemon was killed in the middle of.
        await writeFile(transcriptFile(root, "c1"), `${await readFile(transcriptFile(root, "c1"), "utf8")}{"role":"assistant","te`);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["whole"]);
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

    it("rejoins a torn last line with what is appended after it, as the raw split would", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.append("c1", [said("whole")]);
        await writeFile(transcriptFile(root, "c1"), `${await readFile(transcriptFile(root, "c1"), "utf8")}{"role":"assistant","te`);
        expect(await record.count("c1")).toBe(2);
        // The next append completes nothing: the torn prefix and the new row share one line, which parses as neither.
        await record.append("c1", [said("after")]);
        expect(await record.count("c1")).toBe(2);
        expect(await record.count("c1")).toBe(await fileTranscriptRecord(root).count("c1"));
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["whole"]);
    });

    it("forgets the index a truncate invalidates: the next count reads the shortened record", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [{ role: "user", text: "one" }, said("first"), { role: "user", text: "two" }, said("second")]);
        expect(await record.count("c1")).toBe(4);
        expect(await record.truncate("c1", 2)).toBe(2);
        expect(await record.count("c1")).toBe(2);
        expect((await record.window("c1", {})).rows.map((message) => message.text)).toEqual(["one", "first"]);
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
