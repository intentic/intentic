import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { capabilitiesOf } from "@intentic/sandbox-contract";
import type { PersistedAgent } from "../agents/agents-store.js";
import { statePath } from "../workspace/state-paths.js";

export type PurgeConversation = Pick<PersistedAgent, "id" | "provider" | "harness" | "sessionId">;

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ATTACHMENT_DIR = /\.intentic\/artifacts\/attachments\/([a-zA-Z0-9_-]+)\//g;

const transcript = (historyRoot: string, id: string): string => join(historyRoot, "transcripts", `${id}.jsonl`);

const rawTranscript = async (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

const attachmentDirs = (raw: string): Set<string> =>
    new Set([...raw.matchAll(ATTACHMENT_DIR)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));

const purgeClaudeSession = async (workspaceRoot: string, sessionId: string): Promise<void> => {
    if (!SAFE_ID.test(sessionId)) {
        return;
    }
    const projects = statePath(workspaceRoot, ".intentic/sessions/claude/", "projects");
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

/* Remove only state whose ownership is explicit in the registry/transcript pair. Provider homes other than
 * Claude still mix credentials with native thread state, so this deliberately does not guess inside auth/.
 * Attachment UUID dirs are removed only when no retained transcript mentions the same dir; forks copy message
 * rows and can therefore share an attachment path with their source conversation. */
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
    const claudeSessions = new Set(
        removed.flatMap((entry) =>
            entry.sessionId !== undefined &&
            !retainedSessions.has(entry.sessionId) &&
            capabilitiesOf(entry.provider, entry.harness).runtime === "claude-code"
                ? [entry.sessionId]
                : [],
        ),
    );

    await Promise.all([
        ...removed.map((entry) => rm(transcript(historyRoot, entry.id), { force: true })),
        ...[...orphanedAttachments].map((id) =>
            rm(statePath(workspaceRoot, ".intentic/artifacts/", "attachments", id), { recursive: true, force: true }),
        ),
        ...[...claudeSessions].map((sessionId) => purgeClaudeSession(workspaceRoot, sessionId)),
    ]);
};
