import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type RestoredMessage, RestoredMessageSchema } from "@intentic/sandbox-contract";

/* THE TRANSCRIPT RECORD — what each conversation actually said, written down by the daemon that streamed it.
 *
 * A turn's frames live in memory (turn-runs.ts) and are dropped minutes after it settles, so until now the only
 * durable copy of a conversation was the PROVIDER's session store. That premise is what made "the chat opens
 * empty" a recurring bug rather than an incident: the store is foreign, so reading it back needs the right key
 * into it, and every time that key moved — an archived agent's retired worktree path, an isolated turn filed
 * under the root project key, a runtime session swapped mid-conversation, the CLI's own 30-day sweep — some set
 * of conversations went blank. A provider with no such store at all (codex/grok native, ACP) had no key to get
 * wrong: those chats could never open.
 *
 * One file per conversation, appended once per settled turn, on the HISTORY volume beside the journal and the
 * activity ledger — daemon-private, outside the agent's reach, and surviving the container rebuilds that recreate
 * everything under ~/. JSONL because the write is an append: a turn's messages are added without reading,
 * re-serializing and re-writing every turn before them.
 *
 * NOT the live path. A running turn is served from its frame log (clients attach and replay from a cursor); this
 * is what the conversation reads back as once nothing is running. A turn the daemon dies under is therefore
 * absent here — turn-resume re-runs it, and its replacement records normally. */

// Ids are filename-safe by construction (conversation ids are UUIDs); a name that isn't is ignored rather than
// trusted into a path, the same rule turn-journal and the approvals queue apply.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface TranscriptRecord {
    /* Add one settled turn. `adopt` supplies the conversation's history so far and is called ONLY when this is
     * the record's first write for the conversation — that is the record OPENING, and a record that opened
     * halfway through a conversation would answer with a transcript missing everything before it. It is how a
     * conversation that ran before this store existed, and one resumed from a session id minted elsewhere, both
     * end up whole. */
    readonly append: (
        conversationId: string,
        messages: readonly RestoredMessage[],
        adopt: () => Promise<readonly RestoredMessage[]>,
    ) => Promise<void>;
    // The whole conversation, oldest first. Empty ⇒ this conversation has no record (never written, or written
    // under a daemon whose history volume is gone) — the caller decides what that means.
    readonly read: (conversationId: string) => Promise<RestoredMessage[]>;
}

const lines = (messages: readonly RestoredMessage[]): string => messages.map((message) => `${JSON.stringify(message)}\n`).join("");

// One stored line. An append killed mid-write leaves a torn final line, and a schema the contract has since
// moved on from leaves an unparseable row: either must cost that row and not the conversation it sits in — the
// same argument agents-store.ts makes for the roster.
const row = (line: string): RestoredMessage[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return [];
    }
    const message = RestoredMessageSchema.safeParse(parsed);
    return message.success ? [message.data] : [];
};

export const fileTranscriptRecord = (dir: string): TranscriptRecord => ({
    append: async (conversationId, messages, adopt) => {
        if (!FILE_ID.test(conversationId)) {
            return;
        }
        const path = join(dir, `${conversationId}.jsonl`);
        const opened = await stat(path).then(
            () => true,
            () => false,
        );
        const opening = opened ? [] : await adopt();
        if (opening.length === 0 && messages.length === 0) {
            return;
        }
        await mkdir(dir, { recursive: true });
        await appendFile(path, `${lines(opening)}${lines(messages)}`);
    },
    read: async (conversationId) => {
        if (!FILE_ID.test(conversationId)) {
            return [];
        }
        const raw = await readFile(join(dir, `${conversationId}.jsonl`), "utf8").catch(() => undefined);
        if (raw === undefined) {
            return [];
        }
        return raw.split("\n").flatMap((line) => (line.length === 0 ? [] : row(line)));
    },
});
