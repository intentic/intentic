import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { conversationEntry } from "../testing.js";
import { purgeConversationState, type PurgeConversation } from "./conversation-purge.js";
import { claudeStoreOf } from "./session-store.js";
import { transcriptFile } from "./transcript-record.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const conversation = (id: string, sessionId: string, areas?: string[]): PurgeConversation =>
    conversationEntry({ id, sessionId, ...(areas === undefined ? {} : { identity: { areas } }) });

const writeTranscript = async (history: string, id: string, rows: readonly object[]): Promise<void> => {
    const path = transcriptFile(history, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
};

test("purge removes unshared attachments and the shared store's Claude session sidecars, reading each unit's transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-purge-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    const projects = join(workspace, `${STATE_DIR}`, "records", "sessions", "claude", "projects", "-work");
    const attachments = join(workspace, `${STATE_DIR}`, "records", "artifacts", "attachments");
    await Promise.all([
        mkdir(join(projects, "removed-session"), { recursive: true }),
        mkdir(join(projects, "kept-session"), { recursive: true }),
        mkdir(join(attachments, "only-removed"), { recursive: true }),
        mkdir(join(attachments, "shared"), { recursive: true }),
    ]);
    await Promise.all([
        writeTranscript(history, "removed", [
            { role: "user", text: "x", attachments: [`${STATE_DIR}/records/artifacts/attachments/only-removed/a.png`] },
            { role: "user", text: "y", attachments: [`${STATE_DIR}/records/artifacts/attachments/shared/b.png`] },
        ]),
        writeTranscript(history, "kept", [{ role: "user", text: "fork", attachments: [`${STATE_DIR}/records/artifacts/attachments/shared/b.png`] }]),
        writeFile(join(projects, "removed-session.jsonl"), "removed"),
        writeFile(join(projects, "removed-session", "tool.json"), "removed"),
        writeFile(join(projects, "kept-session.jsonl"), "kept"),
        writeFile(join(attachments, "only-removed", "a.png"), "removed"),
        writeFile(join(attachments, "shared", "b.png"), "kept"),
    ]);

    await purgeConversationState(workspace, history, [conversation("removed", "removed-session")], [conversation("kept", "kept-session")]);

    await expect(readFile(join(attachments, "only-removed", "a.png"), "utf8")).rejects.toThrow();
    expect(await readFile(join(attachments, "shared", "b.png"), "utf8")).toBe("kept");
    await expect(readFile(join(projects, "removed-session.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(projects, "removed-session", "tool.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(projects, "kept-session.jsonl"), "utf8")).toBe("kept");
    // The transcript is the unit's, and goes with the unit when the conversation is disposed, not here.
    expect(await readFile(transcriptFile(history, "removed"), "utf8")).toContain("only-removed");
});

test("a fenced conversation's session files are its unit's to take: the shared store is never reached into for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-purge-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    // Where a fenced conversation's transcripts actually are: its own store in its unit. The shared store holds a file
    // under the same session id that belongs to nobody fenced, and must survive.
    const mine = claudeStoreOf(workspace, history, { id: "removed", identity: { areas: ["finance"] } });
    const shared = claudeStoreOf(workspace, history, undefined);
    await Promise.all([mkdir(join(mine, "projects"), { recursive: true }), mkdir(join(shared, "projects", "-work"), { recursive: true })]);
    await Promise.all([
        writeFile(join(mine, "projects", "removed-session.jsonl"), "removed"),
        writeFile(join(shared, "projects", "-work", "removed-session.jsonl"), "someone else's"),
    ]);

    await purgeConversationState(workspace, history, [conversation("removed", "removed-session", ["finance"])], []);

    expect(await readFile(join(shared, "projects", "-work", "removed-session.jsonl"), "utf8")).toBe("someone else's");
    expect(await readFile(join(mine, "projects", "removed-session.jsonl"), "utf8")).toBe("removed");
});
