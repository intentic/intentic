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
    // The member answerable for it, by address; absent for one nobody has claimed.
    readonly owner?: string;
}

interface RegistryEntry {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly sessionId?: unknown;
    readonly owner?: unknown;
}

const ownerOf = (entry: RegistryEntry): string | undefined => {
    const email = (entry.owner as { email?: unknown } | undefined)?.email;
    return typeof email === "string" && email !== "" ? email : undefined;
};

// One registry entry as a conversation, or nothing for one that no recall row can point at (no session yet).
const conversationOf = (entry: RegistryEntry): { readonly sessionId: string; readonly conversation: Conversation } | undefined => {
    if (typeof entry?.id !== "string" || typeof entry.sessionId !== "string" || entry.sessionId === "") {
        return undefined;
    }
    const owner = ownerOf(entry);
    return {
        sessionId: entry.sessionId,
        conversation: { id: entry.id, ...(typeof entry.title === "string" ? { title: entry.title } : {}), ...(owner === undefined ? {} : { owner }) },
    };
};

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
        const found = conversationOf(entry);
        if (found !== undefined) {
            bySession.set(found.sessionId, found.conversation);
        }
    }
    return bySession;
};
