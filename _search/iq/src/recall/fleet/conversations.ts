import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HISTORY_ROOT } from "@intentic/constants";

// Maps a recall session's bare uuid to its fleet conversation (title, owner); reads the daemon's conversations database
// read-only, one row per conversation. Tolerant: `iq` also runs with no daemon nearby, so a read failure means there is
// no fleet here, and returns an empty map rather than failing the search.

export interface Conversation {
    // Conversation id; also its branch name and worktree dir, the handle other surfaces use (`agents show <id>`).
    readonly id: string;
    readonly title?: string;
    // The member answerable for it, by address; absent for one nobody has claimed.
    readonly owner?: string;
}

interface ConversationRow {
    readonly id: string;
    readonly sessionId: unknown;
    readonly title: unknown;
    readonly owner: unknown;
}

// Only the fields this reader needs, pulled out of the stored record in place: the rest of its shape is the daemon's.
const ROWS = `SELECT id,
    json_extract(record, '$.sessionId') AS sessionId,
    json_extract(record, '$.social.title.text') AS title,
    json_extract(record, '$.social.owner.email') AS owner
FROM conversation`;

const readRows = (historyRoot: string): ConversationRow[] => {
    const db = new DatabaseSync(join(historyRoot, "conversations.db"), { readOnly: true });
    try {
        return db.prepare(ROWS).all() as unknown as ConversationRow[];
    } finally {
        db.close();
    }
};

// One row as a conversation, or nothing for one that no recall row can point at (no session yet).
const conversationOf = (row: ConversationRow): { readonly sessionId: string; readonly conversation: Conversation } | undefined => {
    if (typeof row.sessionId !== "string" || row.sessionId === "") {
        return undefined;
    }
    return {
        sessionId: row.sessionId,
        conversation: {
            id: row.id,
            ...(typeof row.title === "string" ? { title: row.title } : {}),
            ...(typeof row.owner === "string" && row.owner !== "" ? { owner: row.owner } : {}),
        },
    };
};

// Keyed on the session id: what a recall row holds and needs translated into a conversation.
export const conversationsBySession = (historyRoot: string = HISTORY_ROOT): Map<string, Conversation> => {
    let rows: ConversationRow[];
    try {
        rows = readRows(historyRoot);
    } catch {
        return new Map();
    }
    const bySession = new Map<string, Conversation>();
    for (const row of rows) {
        const found = conversationOf(row);
        if (found !== undefined) {
            bySession.set(found.sessionId, found.conversation);
        }
    }
    return bySession;
};
