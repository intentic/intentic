import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { capabilitiesOf, isConversationId } from "@intentic/sandbox-contract";
import type { PersistedAgent } from "../agents/registry/agents-store.js";
import { claudeStoreOf, sessionsDir } from "./session-store.js";
import { statePath } from "../workspace/layout/state-paths.js";

// `areas` is what decides where this conversation's session state lives, so a purge that cannot read it leaves the
// fenced copy behind.
export type PurgeConversation = Pick<PersistedAgent, "id" | "provider" | "harness" | "sessionId" | "areas">;

const ATTACHMENT_DIR = /\.intentic\/records\/artifacts\/attachments\/([a-zA-Z0-9_-]+)\//g;

const transcript = (historyRoot: string, id: string): string => join(historyRoot, "transcripts", `${id}.jsonl`);

const rawTranscript = async (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

const attachmentDirs = (raw: string): Set<string> =>
    new Set([...raw.matchAll(ATTACHMENT_DIR)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));

const purgeClaudeSession = async (store: string, sessionId: string): Promise<void> => {
    if (!isConversationId(sessionId)) {
        return;
    }
    const projects = join(store, "projects");
    const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
    await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) => [
                rm(join(projects, entry.name, `${sessionId}.jsonl`), { force: true }),
                rm(join(projects, entry.name, sessionId), { recursive: true, force: true }),
            ]),
    );
};

/* Purge only state owned explicitly by the registry and transcript pair. */
export const purgeConversationState = async (
    workspaceRoot: string,
    historyRoot: string,
    removed: readonly PurgeConversation[],
    retained: readonly PurgeConversation[],
): Promise<void> => {
    const removedIds = new Set(removed.map((entry) => entry.id));
    const transcriptDir = join(historyRoot, "transcripts");
    const files = await readdir(transcriptDir, { withFileTypes: true }).catch(() => []);
    const retainedRaw = await Promise.all(
        files
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !removedIds.has(entry.name.slice(0, -6)))
            .map((entry) => rawTranscript(join(transcriptDir, entry.name))),
    );
    const retainedAttachments = new Set(retainedRaw.flatMap((raw) => Array.from(attachmentDirs(raw))));
    const removedRaw = await Promise.all(removed.map((entry) => rawTranscript(transcript(historyRoot, entry.id))));
    const orphanedAttachments = new Set(removedRaw.flatMap((raw) => Array.from(attachmentDirs(raw))).filter((id) => !retainedAttachments.has(id)));

    const retainedSessions = new Set(retained.flatMap((entry) => (entry.sessionId === undefined ? [] : [entry.sessionId])));
    // Which store to reach into is now per conversation: a fenced one keeps its own, and that store holds nothing but
    // this conversation, so it goes whole rather than session by session.
    const claudeSessions = removed.flatMap((entry) =>
        entry.sessionId !== undefined &&
        entry.areas === undefined &&
        !retainedSessions.has(entry.sessionId) &&
        capabilitiesOf(entry.provider, entry.harness).runtime === "claude-code"
            ? [entry.sessionId]
            : [],
    );

    await Promise.all([
        ...removed.map((entry) => rm(transcript(historyRoot, entry.id), { force: true })),
        ...[...orphanedAttachments].map((id) =>
            rm(statePath(workspaceRoot, ".intentic/records/artifacts/", "attachments", id), { recursive: true, force: true }),
        ),
        ...[...new Set(claudeSessions)].map((sessionId) => purgeClaudeSession(claudeStoreOf(workspaceRoot, historyRoot, undefined), sessionId)),
        ...removed.flatMap((entry) => (entry.areas === undefined ? [] : [rm(sessionsDir(historyRoot, entry.id), { recursive: true, force: true })])),
    ]);
};
