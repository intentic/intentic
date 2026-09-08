import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";

// Maps a recall session's bare uuid to its fleet conversation (branch name, title); reads the daemon's fleet registry
// as a plain file, one entry per conversation. Tolerant: `iq` also runs with no daemon nearby, so a read failure means
// there is no fleet here, and returns an empty map rather than failing the search.

export interface Conversation {
    // Conversation id; also its branch name and worktree dir, the handle other surfaces use (`agents show <id>`).
    readonly id: string;
    readonly title?: string;
}

interface RegistryEntry {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly sessionId?: unknown;
}

// Keyed on the session id: what a recall row holds and needs translated into a conversation.
export const conversationsBySession = (historyRoot: string = HISTORY_ROOT): Map<string, Conversation> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(join(historyRoot, "agents.json"), "utf8"));
    } catch {
        return new Map();
    }
    if (!Array.isArray(parsed)) {
        return new Map();
    }
    const bySession = new Map<string, Conversation>();
    for (const entry of parsed as RegistryEntry[]) {
        if (typeof entry?.id === "string" && typeof entry.sessionId === "string" && entry.sessionId !== "") {
            bySession.set(entry.sessionId, { id: entry.id, ...(typeof entry.title === "string" ? { title: entry.title } : {}) });
        }
    }
    return bySession;
};
