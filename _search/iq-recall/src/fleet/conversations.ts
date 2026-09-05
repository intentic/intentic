import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";

/* WHOSE CONVERSATION A RUNTIME SESSION BELONGS TO, which is the one fact `iq sessions` could never answer.
 *
 * A recall listing is keyed on the provider's own session id — a bare uuid — and titled from whatever the
 * transcript happened to name itself, which for an agent-run session is nothing at all. So the listing read
 * as a column of uuids and the word "(untitled)", while the daemon next door held the branch, the title, the
 * status and the model for every one of them. `b3366e2e-…` IS `fair-sage-ey2r`, and nothing said so, which is
 * how an agent that had one spelling of a conversation ended up searching the disk for the other.
 *
 * The join is the daemon's fleet registry, read as a plain file: one entry per conversation, each carrying the
 * runtime session its turns ran on.
 *
 * TOLERANT BY DESIGN, and that is not defensiveness. `iq` runs outside a sandbox too — on a laptop, in CI,
 * against a checkout with no daemon anywhere near it — where this file simply does not exist. Every failure to
 * read it means the same thing, "there is no fleet here", and answers the empty map, which degrades the
 * listing to exactly what it printed before this existed rather than failing a search over it. */

export interface Conversation {
    // The conversation id, which is also its branch's name and its worktree's directory: the handle every
    // other surface in the sandbox takes (`agents show <id>`).
    readonly id: string;
    readonly title?: string;
}

interface RegistryEntry {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly sessionId?: unknown;
}

// Keyed on the SESSION id, because that is what a recall row holds and what it needs translating from.
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
