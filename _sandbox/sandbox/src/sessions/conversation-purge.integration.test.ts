import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { purgeConversationState, type PurgeConversation } from "./conversation-purge.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const conversation = (id: string, sessionId: string): PurgeConversation => ({ id, sessionId, provider: "claude", harness: "native" });

test("purge removes owned transcripts, unshared attachments, and Claude session sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-purge-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    const transcripts = join(history, "transcripts");
    const projects = join(workspace, `${STATE_DIR}`, "sessions", "claude", "projects", "-work");
    const attachments = join(workspace, `${STATE_DIR}`, "artifacts", "attachments");
    await Promise.all([
        mkdir(transcripts, { recursive: true }),
        mkdir(join(projects, "removed-session"), { recursive: true }),
        mkdir(join(projects, "kept-session"), { recursive: true }),
        mkdir(join(attachments, "only-removed"), { recursive: true }),
        mkdir(join(attachments, "shared"), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(
            join(transcripts, "removed.jsonl"),
            `${JSON.stringify({ role: "user", text: "x", attachments: [`${STATE_DIR}/artifacts/attachments/only-removed/a.png`] })}\n` +
                `${JSON.stringify({ role: "user", text: "y", attachments: [`${STATE_DIR}/artifacts/attachments/shared/b.png`] })}\n`,
        ),
        writeFile(
            join(transcripts, "kept.jsonl"),
            `${JSON.stringify({ role: "user", text: "fork", attachments: [`${STATE_DIR}/artifacts/attachments/shared/b.png`] })}\n`,
        ),
        writeFile(join(projects, "removed-session.jsonl"), "removed"),
        writeFile(join(projects, "removed-session", "tool.json"), "removed"),
        writeFile(join(projects, "kept-session.jsonl"), "kept"),
        writeFile(join(attachments, "only-removed", "a.png"), "removed"),
        writeFile(join(attachments, "shared", "b.png"), "kept"),
    ]);

    await purgeConversationState(workspace, history, [conversation("removed", "removed-session")], [conversation("kept", "kept-session")]);

    await expect(readFile(join(transcripts, "removed.jsonl"), "utf8")).rejects.toThrow();
    expect(await readFile(join(transcripts, "kept.jsonl"), "utf8")).toContain("fork");
    await expect(readFile(join(attachments, "only-removed", "a.png"), "utf8")).rejects.toThrow();
    expect(await readFile(join(attachments, "shared", "b.png"), "utf8")).toBe("kept");
    await expect(readFile(join(projects, "removed-session.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(projects, "removed-session", "tool.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(projects, "kept-session.jsonl"), "utf8")).toBe("kept");
});
