import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
    /* Open the record BEFORE its next turn starts. `adopt` supplies history from before this record existed.
     * This boundary is load-bearing: opening at settlement re-reads the provider store AFTER it has recorded
     * the new turn, then appends the live frames for that same turn — duplicating every first turn and doing a
     * provider-store parse on the daemon's hottest completion path. An empty file is a real open record: it
     * says there was no older history, so settlement can only append what just streamed. */
    readonly open: (conversationId: string, adopt: () => Promise<readonly RestoredMessage[]>) => Promise<void>;
    // Add one settled turn. Callers open first; append never consults a provider store.
    readonly append: (conversationId: string, messages: readonly RestoredMessage[]) => Promise<void>;
    // The whole conversation, oldest first. Empty ⇒ this conversation has no record (never written, or written
    // under a daemon whose history volume is gone) — the caller decides what that means.
    readonly read: (conversationId: string) => Promise<RestoredMessage[]>;
    // The record's byte size, undefined when no record exists. Append-only plus rewind's truncate, so this is a
    // version key in both directions: any change moves it, which is what lets the search fan-out cache what it
    // extracted instead of re-reading the whole store per keystroke (see agent-transcript.ts).
    readonly size: (conversationId: string) => Promise<number | undefined>;
    /* How many messages the record holds — the position the NEXT turn will start at, which is the index its
     * checkpoint is filed under and the count a rewind to it keeps.
     *
     * Counts stored ROWS, not parsed messages, for the same reason truncate slices raw lines: `read` drops a
     * torn or schema-stale row, and a count that skipped it would file the checkpoint one short of where the
     * next append actually lands. Reading without parsing is also what keeps this affordable on the turn-start
     * path, which is the only place it is called. */
    readonly count: (conversationId: string) => Promise<number>;
    /* THE ONE OPERATION THAT SHORTENS A RECORD — a rewind, dropping every message after the one the user went
     * back to. Everything else here only ever appends, and this is deliberately the single exception rather
     * than a general edit: the file's whole value is being the daemon's own account of what it streamed.
     *
     * Rewritten whole through a temp file and a rename, for the reason store/json-file.ts spells out at
     * length — a bare truncate-and-fill leaves a reader in that window holding half a transcript, and every
     * reader here treats an unparseable tail as "the record ends there". A rename is atomic within the
     * directory, so a concurrent read sees the whole old record or the whole new one.
     *
     * Returns how many messages were dropped; 0 when the record is already that short (which makes a repeated
     * rewind to the same message a no-op rather than an error). */
    readonly truncate: (conversationId: string, keep: number) => Promise<number>;
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

/* THE STORED ROWS, unparsed — the one notion of "position in this record" that read, count and truncate all
 * share. They must agree: `read` drops a row it cannot parse, so counting or slicing parsed messages instead
 * would renumber everything after the first bad row, and the index a checkpoint was filed under would address
 * a different message than the one the user clicked. */
const rawRows = async (path: string): Promise<string[]> => {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    return raw === undefined ? [] : raw.split("\n").filter((line) => line.length > 0);
};

export const fileTranscriptRecord = (dir: string): TranscriptRecord => ({
    open: async (conversationId, adopt) => {
        if (!FILE_ID.test(conversationId)) {
            return;
        }
        const path = join(dir, `${conversationId}.jsonl`);
        const opened = await stat(path).then(
            () => true,
            () => false,
        );
        if (opened) {
            return;
        }
        // Adoption finishes before the provider starts (startConversationTurn awaits this promise), so the
        // provider store still contains only older turns. `wx` makes two accidental openers converge without
        // either overwriting the other; the conversation mutex normally means there is only one.
        const opening = await adopt();
        await mkdir(dir, { recursive: true });
        await writeFile(path, lines(opening), { flag: "wx" }).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        });
    },
    append: async (conversationId, messages) => {
        if (!FILE_ID.test(conversationId) || messages.length === 0) {
            return;
        }
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, `${conversationId}.jsonl`), lines(messages));
    },
    read: async (conversationId) => {
        if (!FILE_ID.test(conversationId)) {
            return [];
        }
        return (await rawRows(join(dir, `${conversationId}.jsonl`))).flatMap(row);
    },
    count: async (conversationId) => (FILE_ID.test(conversationId) ? (await rawRows(join(dir, `${conversationId}.jsonl`))).length : 0),
    size: async (conversationId) => {
        if (!FILE_ID.test(conversationId)) {
            return undefined;
        }
        return stat(join(dir, `${conversationId}.jsonl`)).then(
            (info) => info.size,
            () => undefined,
        );
    },
    truncate: async (conversationId, keep) => {
        if (!FILE_ID.test(conversationId)) {
            return 0;
        }
        const path = join(dir, `${conversationId}.jsonl`);
        const rows = await rawRows(path);
        if (rows.length <= keep) {
            return 0;
        }
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, rows.slice(0, keep).map((line) => `${line}\n`).join(""));
        await rename(temp, path);
        return rows.length - keep;
    },
});
