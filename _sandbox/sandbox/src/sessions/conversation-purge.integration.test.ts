import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { conversationEntry } from "../testing.js";
import { purgeConversationState, type PurgeConversation } from "./conversation-purge.js";
import { removeCodexRollout } from "../runtimes/codex/codex-sessions.js";
import { backupFile } from "./record/record-convert.js";
import { claudeStoreOf } from "./session-store.js";
import { fileTranscriptRecord, transcriptFile } from "./transcript-record.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const conversation = (id: string, sessionId: string, areas?: string[]): PurgeConversation =>
    conversationEntry({ id, sessionId, ...(areas === undefined ? {} : { identity: { areas } }) });

const writeTranscript = (history: string, id: string, rows: readonly TranscriptRow[]): Promise<void> => fileTranscriptRecord(history).append(id, rows);

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

    await purgeConversationState(workspace, history, fileTranscriptRecord(history).stored, [conversation("removed", "removed-session")], [conversation("kept", "kept-session")]);

    await expect(readFile(join(attachments, "only-removed", "a.png"), "utf8")).rejects.toThrow();
    expect(await readFile(join(attachments, "shared", "b.png"), "utf8")).toBe("kept");
    await expect(readFile(join(projects, "removed-session.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(projects, "removed-session", "tool.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(projects, "kept-session.jsonl"), "utf8")).toBe("kept");
    // The transcript is the unit's, and goes with the unit when the conversation is disposed, not here.
    expect((await fileTranscriptRecord(history).stored("removed")).join("\n")).toContain("only-removed");
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

    await purgeConversationState(workspace, history, fileTranscriptRecord(history).stored, [conversation("removed", "removed-session", ["finance"])], []);

    expect(await readFile(join(shared, "projects", "-work", "removed-session.jsonl"), "utf8")).toBe("someone else's");
    expect(await readFile(join(mine, "projects", "removed-session.jsonl"), "utf8")).toBe("removed");
});

test("a retained transcript that cannot be read stops the purge before any upload it might name is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-purge-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    const attachments = join(workspace, `${STATE_DIR}`, "records", "artifacts", "attachments");
    await mkdir(join(attachments, "shared"), { recursive: true });
    await writeFile(join(attachments, "shared", "b.png"), "kept");
    await writeTranscript(history, "removed", [{ role: "user", text: "y", attachments: [`${STATE_DIR}/records/artifacts/attachments/shared/b.png`] }]);
    // Exists but reads as EISDIR: nothing here says which uploads the retained conversation still names.
    await mkdir(transcriptFile(history, "kept"), { recursive: true });

    await expect(
        purgeConversationState(workspace, history, fileTranscriptRecord(history).stored, [conversation("removed", "removed-session")], [conversation("kept", "kept-session")]),
    ).rejects.toThrow(
        /EISDIR/,
    );

    expect(await readFile(join(attachments, "shared", "b.png"), "utf8")).toBe("kept");
});

test("purge also takes the transcript backup, Claude's per-session todos and environment, and a Codex thread's rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-purge-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    const store = claudeStoreOf(workspace, history, undefined);
    const codexHome = join(root, "codex");
    const rollouts = join(codexHome, "sessions", "2026", "01", "02");
    await Promise.all([
        mkdir(join(store, "todos"), { recursive: true }),
        mkdir(join(store, "session-env", "removed-session"), { recursive: true }),
        mkdir(rollouts, { recursive: true }),
        mkdir(join(history, "backups", "transcripts"), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(store, "todos", "removed-session-agent-removed-session.json"), "[]"),
        writeFile(join(store, "todos", "kept-session-agent-kept-session.json"), "[]"),
        writeFile(join(store, "session-env", "removed-session", "env"), "x"),
        writeFile(join(rollouts, "rollout-2026-01-02T10-00-00-thread-1.jsonl"), "said"),
        writeFile(join(rollouts, "rollout-2026-01-02T11-00-00-thread-2.jsonl"), "kept"),
        writeFile(backupFile(history, "removed"), "backup"),
        writeFile(backupFile(history, "codexed"), "backup"),
    ]);
    const codexed = conversationEntry({ id: "codexed", sessionId: "thread-1", profile: { provider: "codex", harness: "native" } });

    await purgeConversationState(
        workspace,
        history,
        fileTranscriptRecord(history).stored,
        [conversation("removed", "removed-session"), codexed],
        [conversation("kept", "kept-session")],
        (threadId) => removeCodexRollout(codexHome, threadId),
    );

    await expect(readFile(backupFile(history, "removed"), "utf8")).rejects.toThrow();
    await expect(readFile(backupFile(history, "codexed"), "utf8")).rejects.toThrow();
    await expect(readFile(join(store, "todos", "removed-session-agent-removed-session.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(store, "todos", "kept-session-agent-kept-session.json"), "utf8")).toBe("[]");
    await expect(readFile(join(store, "session-env", "removed-session", "env"), "utf8")).rejects.toThrow();
    await expect(readFile(join(rollouts, "rollout-2026-01-02T10-00-00-thread-1.jsonl"), "utf8")).rejects.toThrow();
    expect(await readFile(join(rollouts, "rollout-2026-01-02T11-00-00-thread-2.jsonl"), "utf8")).toBe("kept");
});
