import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { isConversationId, type SystemPromptDisclosure, SystemPromptDisclosureSchema } from "@intentic/sandbox-contract";
import { conversationUnit } from "../../store/conversation-units.js";
import { readJsonMarker } from "../../store/plain-files/json-marker.js";

// What each conversation was last told, one small JSON in its unit beside its transcript. Overwritten by every turn
// rather than appended: the reader's question is what this conversation runs on NOW, and a history of a prompt that is
// byte-stable across a session would be the same answer written forty times.
//
// Kept out of the transcript deliberately. A composed prompt is tens of kilobytes; carried in the record it would ride
// to every browser that opens the chat, for something read only when someone asks.

// A composed prompt runs to tens of kilobytes; this is room for one far past that, and still a bound on a damaged file.
const PROMPT_RECORD_MAX_BYTES = 4 * 1024 * 1024;

// Ids are filename-safe by construction; a name that fails validation is never trusted into a path.
const fileOf = (historyRoot: string, conversationId: string): string | undefined =>
    isConversationId(conversationId) ? join(conversationUnit(historyRoot, conversationId), "system-prompt.json") : undefined;

export interface PromptRecord {
    // Remember what this conversation's newest turn was told.
    readonly record: (conversationId: string, disclosure: SystemPromptDisclosure) => Promise<void>;
    // What it was told, or undefined for a conversation that has dispatched no turn since the daemon began recording.
    readonly of: (conversationId: string) => Promise<SystemPromptDisclosure | undefined>;
}

export const filePromptRecord = (historyRoot: string): PromptRecord => ({
    record: async (conversationId, disclosure) => {
        const path = fileOf(historyRoot, conversationId);
        if (path === undefined) {
            return;
        }
        // Whole or not at all: a reader racing the next turn's write, or a crash in the middle of it, would otherwise read
        // a torn record as no record.
        await writeFileAtomic(path, JSON.stringify(disclosure));
    },
    of: async (conversationId) => {
        const path = fileOf(historyRoot, conversationId);
        if (path === undefined) {
            return undefined;
        }
        // A record written by an older shape is nothing rather than an error: the next turn overwrites it.
        return await readJsonMarker(path, SystemPromptDisclosureSchema, { maxBytes: PROMPT_RECORD_MAX_BYTES });
    },
});
