import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isConversationId } from "@intentic/sandbox-contract";

// One directory per conversation on the history volume, holding every file the daemon keeps for it; each file's owner
// names it inside (its transcript, what it was last told, a fenced conversation's own runtime store). Removing the
// directory removes all of them, whatever they are, so nothing here lists them.

export const conversationsRoot = (historyRoot: string): string => join(historyRoot, "conversations");

// Throws on anything that is not a conversation id, the guard every path built from one relies on.
export const conversationUnit = (historyRoot: string, id: string): string => {
    if (!isConversationId(id)) {
        throw new Error(`not a conversation id: ${JSON.stringify(id)}`);
    }
    return join(conversationsRoot(historyRoot), id);
};

export interface ConversationUnits {
    readonly dir: (id: string) => string;
    // Each conversation's directory, whole.
    readonly remove: (ids: readonly string[]) => Promise<void>;
    // Removes the directories no registered conversation owns, answering their ids.
    readonly sweep: (now: number) => Promise<string[]>;
    // The first `limit` files under one conversation's directory, relative to it, and how many there are in all.
    readonly files: (id: string, limit: number) => Promise<{ readonly files: { readonly path: string; readonly bytes: number }[]; readonly total: number }>;
}

// Younger than this, a directory without a conversation is one being opened: a fork copies its transcript before the
// turn that registers it begins. A hang bound on that gap, far above the slow case.
const OPENING_GRACE_MS = 60 * 60_000;

// `registered` asks the database, not a loaded roster: a row this build cannot read still owns its directory.
export const conversationUnits = (historyRoot: string, registered: (id: string) => boolean): ConversationUnits => ({
    dir: (id) => conversationUnit(historyRoot, id),
    remove: async (ids) => {
        await Promise.all(ids.map((id) => rm(conversationUnit(historyRoot, id), { recursive: true, force: true })));
    },
    sweep: async (now) => {
        const swept: string[] = [];
        for (const entry of await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(() => [])) {
            // Asked at the decision, since this runs behind boot while conversations are being opened.
            if (!entry.isDirectory() || !isConversationId(entry.name) || registered(entry.name)) {
                continue;
            }
            const dir = conversationUnit(historyRoot, entry.name);
            const changed = await stat(dir).then(
                (info) => info.mtimeMs,
                () => now,
            );
            if (now - changed < OPENING_GRACE_MS) {
                continue;
            }
            await rm(dir, { recursive: true, force: true });
            swept.push(entry.name);
        }
        return swept;
    },
    files: async (id, limit) => {
        const dir = conversationUnit(historyRoot, id);
        const found = (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name))
            .toSorted();
        const files = await Promise.all(found.slice(0, limit).map(async (path) => ({ path: relative(dir, path), bytes: (await stat(path)).size })));
        return { files, total: found.length };
    },
});
