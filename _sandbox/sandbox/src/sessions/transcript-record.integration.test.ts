import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AgentHarness, type AgentProvider, PROVIDERS, HARNESSES, type RestoredMessage } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { fileTranscriptRecord } from "./transcript-record.js";
import { restoredTurn } from "./turn-transcript.js";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "transcript-record-"));

const said = (text: string): RestoredMessage => ({ role: "assistant", text });
const nothing = (): Promise<RestoredMessage[]> => Promise.resolve([]);

describe("fileTranscriptRecord", () => {
    it("reads back the turns it was given, oldest first", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.open("c1", nothing);
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "two", "second"]);
    });

    it("keeps conversations apart, and answers empty for one it has never seen", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.open("c1", nothing);
        await record.append("c1", [said("mine")]);
        expect(await record.read("c2")).toEqual([]);
    });

    /* The opening adoption. A conversation that ran before the record existed keeps its history: without this,
     * its FIRST turn under the record would become its whole transcript and everything before it would vanish
     * from the chat: the very failure this store exists to end, reintroduced by the store itself. */
    it("adopts the history a conversation already had, once, when the record opens", async () => {
        const record = fileTranscriptRecord(await dir());
        let adoptions = 0;
        const adopt = (): Promise<RestoredMessage[]> => {
            adoptions += 1;
            return Promise.resolve([said("from before")]);
        };
        await record.open("c1", adopt);
        await record.append("c1", [said("first recorded")]);
        await record.open("c1", adopt);
        await record.append("c1", [said("second recorded")]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["from before", "first recorded", "second recorded"]);
        expect(adoptions).toBe(1);
    });

    /* An adoption that comes back EMPTY is ambiguous: a conversation with genuinely nothing behind it looks
     * exactly like one whose provider store could not be read (an id the registry never learned, a swept
     * session file, a runtime with no store at all). Writing the empty file made the second case permanent:
     * every later open saw a file and returned early, and a conversation frozen that way then seeds every
     * runtime handoff for the rest of its life with nothing. */
    it("re-adopts while adoption is empty, and stops as soon as there is something to open with", async () => {
        const record = fileTranscriptRecord(await dir());
        let available: RestoredMessage[] = [];
        let adoptions = 0;
        const adopt = (): Promise<RestoredMessage[]> => {
            adoptions += 1;
            return Promise.resolve(available);
        };

        await record.open("c1", adopt);
        expect(await record.read("c1")).toEqual([]);

        // The store answers on a later turn. The retry is the only reason this conversation ever picks it up.
        available = [said("from before")];
        await record.open("c1", adopt);
        await record.open("c1", adopt);

        expect((await record.read("c1")).map((message) => message.text)).toEqual(["from before"]);
        expect(adoptions).toBe(2);
    });

    // What bounds the retry: the first settled turn creates the file, so a conversation that really has no
    // history stops re-asking after one turn rather than probing the provider store forever.
    it("stops re-adopting once a turn has been recorded, even though adoption stayed empty", async () => {
        const record = fileTranscriptRecord(await dir());
        let adoptions = 0;
        const adopt = (): Promise<RestoredMessage[]> => {
            adoptions += 1;
            return Promise.resolve([]);
        };

        await record.open("c1", adopt);
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.open("c1", adopt);

        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first"]);
        expect(adoptions).toBe(1);
    });

    /* A BRANCH opens as a copy of the conversation it was cut from: the one opening history no provider store
     * and no adoption could supply, since the branch is a conversation nothing else knows about yet. Copying it
     * is what lets a branch seed a switched session and read back in full, instead of appearing to begin at the
     * edit. */
    it("opens a branch with the source's first rows and leaves the source alone", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.open("c1", nothing);
        await record.append("c1", [{ role: "user", text: "one" }, said("first")]);
        await record.append("c1", [{ role: "user", text: "two" }, said("second")]);

        await record.fork("c2", "c1", 2);
        await record.append("c2", [{ role: "user", text: "two, revised" }, said("redone")]);

        expect((await record.read("c2")).map((message) => message.text)).toEqual(["one", "first", "two, revised", "redone"]);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["one", "first", "two", "second"]);
    });

    it("leaves an already-opened branch alone, so a repeated origin cannot re-copy over its turns", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.open("c1", nothing);
        await record.append("c1", [said("source")]);
        await record.fork("c2", "c1", 1);
        await record.append("c2", [said("branch's own")]);

        await record.fork("c2", "c1", 1);
        expect((await record.read("c2")).map((message) => message.text)).toEqual(["source", "branch's own"]);
    });

    it("costs a torn final line its own row, not the conversation above it", async () => {
        const root = await dir();
        const record = fileTranscriptRecord(root);
        await record.open("c1", nothing);
        await record.append("c1", [said("whole")]);
        // A write the daemon was killed in the middle of.
        await writeFile(join(root, "c1.jsonl"), `${await readFile(join(root, "c1.jsonl"), "utf8")}{"role":"assistant","te`);
        expect((await record.read("c1")).map((message) => message.text)).toEqual(["whole"]);
    });

    it("ignores an id that is not filename-safe rather than letting it reach a path", async () => {
        const record = fileTranscriptRecord(await dir());
        await record.open("../escape", nothing);
        await record.append("../escape", [said("nope")]);
        expect(await record.read("../escape")).toEqual([]);
    });
});

/* THE DISCOVERY GUARD.
 *
 * "The chat opens empty" kept coming back because the transcript was re-derived from whatever store the
 * PROVIDER kept, so every provider/harness pair was its own chance to have no reader, no key, or no store at
 * all, and codex/grok native and ACP never had one. The fix is that a turn's own frames are the transcript, and
 * this is the test that keeps it true: it drives every pair the catalog can produce through the same reduction
 * the daemon uses at settle, and demands a readable conversation out the other end.
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
        await record.open(id, nothing);
        await record.append(id, restoredTurn(turn, events, WORKSPACE_ROOT, 1_767_225_600_000));
        const restored = await record.read(id);
        expect(restored[0]).toEqual({ role: "user", text: "do the thing", sentAt: 1_767_225_600_000 });
        expect(restored.map((message) => message.text)).toContain("on it");
        expect(restored.flatMap((message) => message.tools ?? [])).toEqual([
            { id: "t1", name: "Bash", category: "execute", status: "completed", target: "pnpm test", content: [{ type: "text", text: "1 passed" }] },
        ]);
    });
});
