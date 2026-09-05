import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract";

/* THE TRANSCRIPT RECORD, what each conversation actually said, written down by the daemon that streamed it.
 *
 * A turn's frames live in memory (turn-runs.ts) and are dropped minutes after it settles, so until now the only
 * durable copy of a conversation was the PROVIDER's session store. That premise is what made "the chat opens
 * empty" a recurring bug rather than an incident: the store is foreign, so reading it back needs the right key
 * into it, and every time that key moved, an archived agent's retired worktree path, an isolated turn filed
 * under the root project key, a runtime session swapped mid-conversation, the CLI's own 30-day sweep, some set
 * of conversations went blank. A provider with no such store at all (codex/grok native, ACP) had no key to get
 * wrong: those chats could never open.
 *
 * One file per conversation, appended once per settled turn, on the HISTORY volume beside the journal and the
 * activity ledger, daemon-private, outside the agent's reach, and surviving the container rebuilds that recreate
 * everything under ~/. JSONL because the write is an append: a turn's messages are added without reading,
 * re-serializing and re-writing every turn before them.
 *
 * NOT the live path. A running turn is served from its frame log (clients attach and replay from a cursor); this
 * is what the conversation reads back as once nothing is running. A turn the daemon dies under is therefore
 * absent here, turn-resume re-runs it, and its replacement records normally. */

// Ids are filename-safe by construction (conversation ids are UUIDs); a name that isn't is ignored rather than
// trusted into a path, the same rule turn-journal and the approvals queue apply.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/* HOW MUCH OF A CONVERSATION AN OPEN ASKS FOR. Counted in user turns rather than rows, because a row count
 * cuts wherever it lands: a chat that opens on the back half of an answer, with the question that prompted it
 * above the fold, reads as the agent talking to itself. A turn is the unit a reader actually scrolls by.
 *
 * `maxRows` is the second bound, and it is the one that stops a single turn from defeating the first: a
 * delegation or a long agentic loop can put hundreds of rows behind ONE user message, and a purely
 * turn-counted window would hand back all of them. When the ceiling bites it wins over the turn boundary and
 * the page splits inside the turn; `more` then carries the rest, one page back. */
export interface TranscriptWindow {
    // Return rows before this position, exclusive: the previous page's `from`, and nothing else. Absent means
    // the end of the record, which is what an opening tab asks for.
    readonly before?: number | undefined;
    readonly turns?: number | undefined;
    readonly maxRows?: number | undefined;
}

export interface TranscriptPage {
    readonly rows: TranscriptRow[];
    // Where these rows start in the WHOLE record, and the `before` of the page above them. Absolute, because
    // every other position in this file is (see `count`).
    readonly from: number;
    // Whether anything precedes them, so a client can offer to page back without asking a second time.
    readonly more: boolean;
}

// Enough that a chat opens on more than a screenful and most conversations arrive whole, small enough that the
// longest conversation costs the same as the shortest. Measured in transcript-scale.integration.test.ts.
export const DEFAULT_WINDOW_TURNS = 20;
export const MAX_WINDOW_ROWS = 400;

export interface TranscriptRecord {
    /* Open a record as a COPY of another's first `keep` rows, how a branch begins: a branch is a new
     * conversation, so nothing it should start with is anywhere in its own namespace, and the turns it inherits
     * are sitting in the record it was cut from. Every other record is created by its first settled turn's
     * append, so this is the one opening there is.
     *
     * A `wx` write and a no-op when the file already exists, which is what makes a branch's later turns (which
     * may still name their origin) leave the copy alone. */
    readonly fork: (conversationId: string, source: string, keep: number) => Promise<void>;
    // Add one settled turn, creating the record on the first.
    readonly append: (conversationId: string, messages: readonly TranscriptRow[]) => Promise<void>;
    // The whole conversation, oldest first. Empty ⇒ this conversation has no record (never written, or written
    // under a daemon whose history volume is gone), the caller decides what that means.
    //
    // For a READER, prefer `window`: this one's cost is the conversation's whole length, which is why the
    // route stopped calling it. What is left here are the callers that genuinely need every row (the search
    // backfill, a runtime handoff seeding a replacement session).
    readonly read: (conversationId: string) => Promise<TranscriptRow[]>;
    /* THE TAIL OF A CONVERSATION AND WHERE IT SITS, what a chat opens on and pages back through.
     *
     * Only the returned rows are parsed. Splitting the file is cheap and JSON-parsing it is not, so a window
     * over a conversation that ran all week costs a window, not a week — which was the whole point (a 400-turn
     * record served 3.74 MB to every tab that opened it, and to all forty cards the board warms behind it).
     *
     * A cursor is never an error: `before` past the end clamps to the end, below zero clamps to nothing,
     * fractional floors. A tab that slept through a rewind holds a position the record no longer has, and
     * refusing to open the conversation is a worse answer than opening it at the end. */
    readonly window: (conversationId: string, window: TranscriptWindow) => Promise<TranscriptPage>;
    // The record's byte size, undefined when no record exists. Append-only plus rewind's truncate, so this is a
    // version key in both directions: any change moves it, which is what lets the search fan-out cache what it
    // extracted instead of re-reading the whole store per keystroke (see agent-transcript.ts).
    readonly size: (conversationId: string) => Promise<number | undefined>;
    /* How many messages the record holds, the position the NEXT turn will start at, which is the index its
     * checkpoint is filed under and the count a rewind to it keeps.
     *
     * Counts stored ROWS, not parsed messages, for the same reason truncate slices raw lines: `read` drops a
     * torn or schema-stale row, and a count that skipped it would file the checkpoint one short of where the
     * next append actually lands. Reading without parsing is also what keeps this affordable on the turn-start
     * path, which is the only place it is called. */
    readonly count: (conversationId: string) => Promise<number>;
    /* THE ONE OPERATION THAT SHORTENS A RECORD, a rewind, dropping every message after the one the user went
     * back to. Everything else here only ever appends, and this is deliberately the single exception rather
     * than a general edit: the file's whole value is being the daemon's own account of what it streamed.
     *
     * Rewritten whole through a temp file and a rename, for the reason store/json-file.ts spells out at
     * length, a bare truncate-and-fill leaves a reader in that window holding half a transcript, and every
     * reader here treats an unparseable tail as "the record ends there". A rename is atomic within the
     * directory, so a concurrent read sees the whole old record or the whole new one.
     *
     * Returns how many messages were dropped; 0 when the record is already that short (which makes a repeated
     * rewind to the same message a no-op rather than an error). */
    readonly truncate: (conversationId: string, keep: number) => Promise<number>;
}

const lines = (messages: readonly TranscriptRow[]): string => messages.map((message) => `${JSON.stringify(message)}\n`).join("");

// One stored line. An append killed mid-write leaves a torn final line, and a schema the contract has since
// moved on from leaves an unparseable row: either must cost that row and not the conversation it sits in, the
// same argument agents-store.ts makes for the roster.
const row = (line: string): TranscriptRow[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return [];
    }
    const message = TranscriptRowSchema.safeParse(parsed);
    return message.success ? [message.data] : [];
};

/* THE STORED ROWS, unparsed, the one notion of "position in this record" that read, count and truncate all
 * share. They must agree: `read` drops a row it cannot parse, so counting or slicing parsed messages instead
 * would renumber everything after the first bad row, and the index a checkpoint was filed under would address
 * a different message than the one the user clicked. */
const rawRows = async (path: string): Promise<string[]> => {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    return raw === undefined ? [] : raw.split("\n").filter((line) => line.length > 0);
};

/* WHERE A PAGE ENDS, exclusive. A cursor arrives from a client that may have slept through a rewind or a
 * fork, so every unusable value has an answer rather than a refusal: past the end is the end, below zero is
 * nothing, fractional floors, absent is the end (what an opening tab asks for). */
const pageEnd = (before: number | undefined, length: number): number => Math.min(Math.max(Math.floor(before ?? length), 0), length);

/* THE PAGE ITSELF: walk back from `end` collecting rows until `turns` user messages have opened, or the row
 * ceiling bites. Only what is collected is parsed, which is what makes a window cost a window.
 *
 * A user row OPENS a turn, so meeting the (turns + 1)-th ends the page above it rather than in the middle of
 * it. A torn or schema-stale line parses to nothing and is carried anyway: it costs its own row and never the
 * page, the same rule `read` applies. */
const scanBack = (at: (index: number) => TranscriptRow[], end: number, turns: number, maxRows: number): TranscriptPage => {
    const rows: TranscriptRow[] = [];
    let from = end;
    let seen = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
        const parsed = at(index);
        if (parsed[0]?.role === "user") {
            seen += 1;
        }
        rows.unshift(...parsed);
        from = index;
        /* Stop ON the user row that opens the oldest wanted turn, not on the next one down. Everything below
         * it belongs to the turn before, so a loop that ran until it met another user message would hand back
         * that turn's answers with its question cut off — the exact reading the turn boundary exists to
         * prevent, arrived at from the other side. */
        if (seen === turns) {
            break;
        }
        // The ceiling wins over the turn boundary: one fanned-out turn must not be able to serve the whole
        // conversation back. `more` carries the rest.
        if (end - from >= maxRows) {
            break;
        }
    }
    return { rows, from, more: from > 0 };
};

/* THE SAME WINDOW OVER ROWS ALREADY IN HAND, for a caller holding the record rather than the file: the route
 * fake in route-testing.ts, so its `page` cannot answer a different shape than the daemon's, and any reader
 * that has already paid for the whole record and wants the tail of it. */
export const windowOf = (rows: readonly TranscriptRow[], { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS }: TranscriptWindow): TranscriptPage =>
    scanBack((index) => (rows[index] === undefined ? [] : [rows[index]]), pageEnd(before, rows.length), turns, maxRows);

export const fileTranscriptRecord = (dir: string): TranscriptRecord => ({
    fork: async (conversationId, source, keep) => {
        if (!FILE_ID.test(conversationId) || !FILE_ID.test(source) || keep <= 0) {
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
        // Raw rows, so this slices exactly where `count` and `truncate` do, a branch cut before row N keeps
        // the same N rows a rewind to that point would have kept, torn or schema-stale lines included.
        const rows = (await rawRows(join(dir, `${source}.jsonl`))).slice(0, keep);
        if (rows.length === 0) {
            return;
        }
        await mkdir(dir, { recursive: true });
        await writeFile(path, rows.map((line) => `${line}\n`).join(""), { flag: "wx" }).catch((error: unknown) => {
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
    window: async (conversationId, { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS }) => {
        if (!FILE_ID.test(conversationId)) {
            return { rows: [], from: 0, more: false };
        }
        // Raw rows throughout, the same position `count`, `truncate` and `fork` mean, so a `from` handed to a
        // client addresses the message a rewind would.
        const raw = await rawRows(join(dir, `${conversationId}.jsonl`));
        // Only the rows the page returns are parsed: splitting the file is cheap and JSON.parse is not.
        return scanBack((index) => row(raw[index] ?? ""), pageEnd(before, raw.length), turns, maxRows);
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
        await writeFile(
            temp,
            rows
                .slice(0, keep)
                .map((line) => `${line}\n`)
                .join(""),
        );
        await rename(temp, path);
        return rows.length - keep;
    },
});
