import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AgentHarness, type AgentProvider, PROVIDERS, HARNESSES, type TranscriptRow } from "@intentic/sandbox-contract";
import { foldTurn } from "@intentic/sandbox-contract/transcript-fold";
import { describe, expect, it } from "vitest";
import { fileTranscriptRecord } from "./transcript-record.js";
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

    /* A BRANCH opens as a copy of the conversation it was cut from: the one opening history nothing but a copy
     * could supply, since the branch is a conversation nothing else knows about yet. Copying it is what lets a
     * branch seed a switched session and read back in full, instead of appearing to begin at the edit. */
    it("opens a branch with the source's first rows and leaves the source alone", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);

        await record.fork("c2", "c1", 2);
        await record.append("c2", [{ role: "user", text: "two, revised" }, said("redone")]);

        expect((await record.read("c2")).map((message) => message.text)).toEqual(["one", "first", "two, revised", "redone"]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "two", "second"]);
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
        await writeFile(join(root, "c1.jsonl"), `${await readFile(join(root, "c1.jsonl"), "utf8")}{"role":"assistant","te`);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["whole"]);
    });

    it("ignores an id that is not filename-safe rather than letting it reach a path", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.append("../escape", [said("nope")]);
        expect(await record.read("../escape")).toEqual([]);
    });
});

/* THE DISCOVERY GUARD.
 *
 * "The chat opens empty" kept coming back because the transcript was re-derived from whatever store the
 * PROVIDER kept, so every provider/harness pair was its own chance to have no reader, no key, or no store at
 * all, and codex/grok native and ACP never had one. The fix is that a turn's own frames are the transcript, and
 * this is the test that keeps it true: it drives every pair the catalog can produce through the same fold the
 * daemon runs as the turn streams, and demands a readable conversation out the other end.
 *
 * By SHAPE, not by a list: PROVIDERS × HARNESSES is read from the catalog, so a provider added tomorrow is
 * covered the day it is added. If this fails for a new pair, that pair's turns are not reaching the record: the
 * answer is to make them, never to special-case the read. */
describe("every provider records a readable transcript", () => {
    const turn = { prompt: "do the thing" };
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
        expect(restored[0]).toEqual({ role: "user", text: "do the thing", sentAt: 1_767_225_600_000 });
        expect(restored.map((message) => message.text)).toContain("on it");
        expect(restored.flatMap((message) => message.tools ?? [])).toEqual([
            { id: "t1", name: "Bash", category: "execute", status: "completed", target: "pnpm test", content: [{ type: "text", text: "1 passed" }] },
        ]);
    });
});
