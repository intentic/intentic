import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { capabilitiesOf, isConversationId } from "@intentic/sandbox-contract";
import type { PersistedAgent } from "../agents/registry/agents-store.js";
import { claudeStoreOf } from "./session-store.js";
import { transcriptFile } from "./transcript-record.js";
import { statePath } from "../state-paths.js";
import { conversationsRoot } from "../store/conversation-units.js";

// What a conversation leaves OUTSIDE its unit and its rows, in layouts other owners dictate: its session files in the
// Claude Code store every unfenced conversation shares, and uploads only its transcript names. Runs before the unit goes,
// since the transcripts are what say which uploads are whose.

// `areas` decides where the session state lives, so a purge that cannot read it leaves the fenced copy behind.
export type PurgeConversation = Pick<PersistedAgent, "id" | "profile" | "sessionId" | "identity">;

const ATTACHMENT_DIR = /\.intentic\/records\/artifacts\/attachments\/([a-zA-Z0-9_-]+)\//g;

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

// Uploads the removed conversations' transcripts name and no other conversation's does.
const orphanedAttachments = async (historyRoot: string, removed: readonly PurgeConversation[]): Promise<Set<string>> => {
    const removedIds = new Set(removed.map((entry) => entry.id));
    const units = await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(() => []);
    const retainedRaw = await Promise.all(
        units
            .filter((unit) => unit.isDirectory() && isConversationId(unit.name) && !removedIds.has(unit.name))
            .map((unit) => rawTranscript(transcriptFile(historyRoot, unit.name))),
    );
    const retained = new Set(retainedRaw.flatMap((raw) => [...attachmentDirs(raw)]));
    const removedRaw = await Promise.all(removed.map((entry) => rawTranscript(transcriptFile(historyRoot, entry.id))));
    return new Set(removedRaw.flatMap((raw) => [...attachmentDirs(raw)]).filter((id) => !retained.has(id)));
};

export const purgeConversationState = async (
    workspaceRoot: string,
    historyRoot: string,
    removed: readonly PurgeConversation[],
    retained: readonly PurgeConversation[],
): Promise<void> => {
    const orphaned = await orphanedAttachments(historyRoot, removed);
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
    await Promise.all([
        ...[...orphaned].map((id) => rm(statePath(workspaceRoot, ".intentic/records/artifacts/", "attachments", id), { recursive: true, force: true })),
        ...[...new Set(claudeSessions)].map((sessionId) => purgeClaudeSession(claudeStoreOf(workspaceRoot, historyRoot, undefined), sessionId)),
    ]);
};
