import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isConversationId, type SystemPromptDisclosure, SystemPromptDisclosureSchema } from "@intentic/sandbox-contract";

// What each conversation was last told, one small JSON per conversation beside its transcript. Overwritten by every
// turn rather than appended: the reader's question is what this conversation runs on NOW, and a history of a prompt
// that is byte-stable across a session would be the same answer written forty times.
//
// Kept out of the transcript deliberately. A composed prompt is tens of kilobytes; carried in the record it would ride
// to every browser that opens the chat, for something read only when someone asks.

// Ids are filename-safe by construction; a name that fails validation is never trusted into a path.
const fileOf = (dir: string, conversationId: string): string | undefined =>
    isConversationId(conversationId) ? join(dir, `${conversationId}.json`) : undefined;

export interface PromptRecord {
    // Remember what this conversation's newest turn was told.
    readonly record: (conversationId: string, disclosure: SystemPromptDisclosure) => Promise<void>;
    // What it was told, or undefined for a conversation that has dispatched no turn since the daemon began recording.
    readonly of: (conversationId: string) => Promise<SystemPromptDisclosure | undefined>;
    // Drops one conversation's record, for a purge that is removing the conversation itself.
    readonly forget: (conversationId: string) => Promise<void>;
}

export const filePromptRecord = (dir: string): PromptRecord => ({
    record: async (conversationId, disclosure) => {
        const path = fileOf(dir, conversationId);
        if (path === undefined) {
            return;
        }
        await mkdir(dir, { recursive: true });
        await writeFile(path, JSON.stringify(disclosure));
    },
    of: async (conversationId) => {
        const path = fileOf(dir, conversationId);
        if (path === undefined) {
            return undefined;
        }
        const raw = await readFile(path, "utf8").catch(() => undefined);
        if (raw === undefined) {
            return undefined;
        }
        try {
            // A record written by an older shape is nothing rather than an error: the next turn overwrites it.
            return SystemPromptDisclosureSchema.safeParse(JSON.parse(raw)).data;
        } catch {
            return undefined;
        }
    },
    forget: async (conversationId) => {
        const path = fileOf(dir, conversationId);
        if (path !== undefined) {
            await rm(path, { force: true });
        }
    },
});
