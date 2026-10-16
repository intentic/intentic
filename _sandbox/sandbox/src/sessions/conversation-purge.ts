import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { isConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { claudeStoreOf } from "./session-store.js";
import type { FileTranscriptRecord } from "./transcript-record.js";
import { statePath } from "../state-paths.js";
import { conversationsRoot } from "../store/conversation-units.js";
import { backupFile } from "./record/record-convert.js";

// What a conversation leaves OUTSIDE its unit and its rows, in layouts other owners dictate: its session files in the
// Claude Code store every unfenced conversation shares, and uploads only its transcript names. Runs before the unit goes,
// since the transcripts are what say which uploads are whose.

// The folder a conversation's pages are filed in; a turn with no conversation files its pages together.
export const folderOf = (conversationId: string | undefined): string => (conversationId === undefined ? "loose" : conversationId.replace(/[^A-Za-z0-9_-]/g, "_"));

// Every conversation's pages, for the purge that removes one.
const pagesFolder = (workspaceRoot: string, conversationId: string): string =>
    statePath(workspaceRoot, ".intentic/records/artifacts/", "pages", folderOf(conversationId));

// Removes a conversation's pages with it.
export const purgePages = (workspaceRoot: string, conversationId: string): Promise<void> =>
    rm(pagesFolder(workspaceRoot, conversationId), { recursive: true, force: true });

// `areas` decides where the session state lives, so a purge that cannot read it leaves the fenced copy behind.
export type PurgeConversation = Pick<PersistedAgent, "id" | "profile" | "sessionId" | "identity">;

const ATTACHMENT_DIR = /\.intentic\/records\/artifacts\/attachments\/([a-zA-Z0-9_-]+)\//g;

// A record's lines as stored: an upload is named where it was attached, never only deep inside a long tool output.
type Stored = FileTranscriptRecord["stored"];

const attachmentDirs = (lines: readonly string[]): Set<string> =>
    new Set(
        lines.flatMap((line) =>
            line.includes("/attachments/") ? [...line.matchAll(ATTACHMENT_DIR)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])) : [],
        ),
    );

// The session's transcript in every project folder, and what Claude Code keeps beside it under the session's id: its
// todo lists, its environment and its task lists, which quote what the conversation was about.
const purgeClaudeSession = async (store: string, sessionId: string): Promise<void> => {
    if (!isConversationId(sessionId)) {
        return;
    }
    const projects = join(store, "projects");
    const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const todos = (await readdir(join(store, "todos")).catch(undefinedIfMissing)) ?? [];
    await Promise.all([
        ...entries.flatMap((entry) =>
            entry.isDirectory()
                ? [
                      rm(join(projects, entry.name, `${sessionId}.jsonl`), { force: true }),
                      rm(join(projects, entry.name, sessionId), { recursive: true, force: true }),
                  ]
                : [],
        ),
        ...todos.filter((name) => name.startsWith(`${sessionId}-`)).map((name) => rm(join(store, "todos", name), { force: true })),
        rm(join(store, "session-env", sessionId), { recursive: true, force: true }),
        rm(join(store, "tasks", sessionId), { recursive: true, force: true }),
    ]);
};

// Uploads the removed conversations' transcripts name and no other conversation's does.
const orphanedAttachments = async (historyRoot: string, stored: Stored, removed: readonly PurgeConversation[]): Promise<Set<string>> => {
    const removedIds = new Set(removed.map((entry) => entry.id));
    const units = (await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    const retained = new Set<string>();
    for (const unit of units.filter((entry) => entry.isDirectory() && isConversationId(entry.name) && !removedIds.has(entry.name))) {
        // one record at a time, so only one is ever held in memory.
        for (const id of attachmentDirs(await stored(unit.name))) {
            retained.add(id);
        }
    }
    const named = await Promise.all(removed.map(async (entry) => [...attachmentDirs(await stored(entry.id))]));
    return new Set(named.flat().filter((id) => !retained.has(id)));
};

export const purgeConversationState = async (
    workspaceRoot: string,
    historyRoot: string,
    stored: Stored,
    removed: readonly PurgeConversation[],
    retained: readonly PurgeConversation[],
    // Deletes a Codex thread's rollout, a Codex conversation's transcript; absent leaves them. Handed in, since sessions/
    // sits below the runtimes.
    removeCodexRollout?: (threadId: string) => Promise<void>,
): Promise<void> => {
    const orphaned = await orphanedAttachments(historyRoot, stored, removed);
    const retainedSessions = new Set(retained.flatMap((entry) => (entry.sessionId === undefined ? [] : [entry.sessionId])));
    // A fenced conversation keeps its store in its own unit, which goes whole with it; only the shared store is reached
    // into, session by session.
    const claudeSessions = removed.flatMap((entry) =>
        entry.sessionId !== undefined &&
        entry.identity.areas === undefined &&
        !retainedSessions.has(entry.sessionId) &&
        capabilitiesOf(entry.profile.provider, entry.profile.harness).runtime === "claude-code"
            ? [entry.sessionId]
            : [],
    );
    const codexThreads = removed.flatMap((entry) =>
        entry.sessionId !== undefined && capabilitiesOf(entry.profile.provider, entry.profile.harness).runtime === "codex" && !retainedSessions.has(entry.sessionId)
            ? [entry.sessionId]
            : [],
    );
    await Promise.all([
        // The copy the record-format migration kept of the transcript it converted (record-convert.ts).
        ...removed.map((entry) => rm(backupFile(historyRoot, entry.id), { force: true })),
        ...(removeCodexRollout === undefined ? [] : codexThreads.map((threadId) => removeCodexRollout(threadId))),
        ...[...orphaned].map((id) =>
            rm(statePath(workspaceRoot, ".intentic/records/artifacts/", "attachments", id), { recursive: true, force: true }),
        ),
        ...[...new Set(claudeSessions)].map((sessionId) => purgeClaudeSession(claudeStoreOf(workspaceRoot, historyRoot, undefined), sessionId)),
        // The pages a conversation showed are its own record, and go with it.
        ...removed.map((entry) => purgePages(workspaceRoot, entry.id)),
    ]);
};
