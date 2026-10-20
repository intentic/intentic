import type { AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import { REQUEST_FIELDS, type TranscriptPatch, type TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { patchedRow } from "@intentic/sandbox-contract/transcript-fold";
import type { ChatMessage } from "./transcript";

// The transcript as a value, with every transition as a pure function. Sources are the daemon's already-folded rows
// (transcript-fold.ts) plus lines this window writes itself; transitions here only attach a run's rows, apply patches,
// and pace the typewriter. Frame meaning is decided upstream, not here.

export interface PendingText {
    // Message the buffered text belongs to; a delta for a different message flushes this one first.
    readonly id: number;
    readonly text: string;
}

export interface TranscriptState {
    readonly messages: readonly ChatMessage[];
    // Monotonic id allocator kept in state, since allocating an id is itself a replayable transition.
    readonly nextId: number;
    readonly pending: PendingText | undefined;
    // The cursor a patch's index counts from: where the attached run's rows start. Re-derived from those rows on
    // every head (baseFor), so it can only ever restate what the rows themselves already say.
    readonly attached?: { readonly run: string; readonly base: number };
}

export const emptyTranscriptState: TranscriptState = { messages: [], nextId: 1, pending: undefined };

export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

// Rows this window writes.

export const appendMessage = (state: TranscriptState, message: Omit<ChatMessage, "id">): TranscriptState => ({
    ...state,
    messages: [...state.messages, { ...message, id: state.nextId }],
    nextId: state.nextId + 1,
});

// A RECORD REDRAWN KEEPS THE ROWS IT ALREADY DREW. Opening a chat paints the local mirror and then the daemon's record
// replaces it, and replay after a reconnect or a Retry does the same: with every row a fresh object, every row's markdown
// was parsed, sanitised and laid out again for words that had not changed — on a phone, seconds of a frozen chat to
// redraw what was on screen. A message already standing that is the same row is kept, id and all (the list's key and its
// memo both hold). The same row is the one with its `rowId`, wherever the sandbox names rows; a named prompt keeps its
// id even when its checkpoint metadata changes, since that id keys the whole turn, and remounting it discards every
// reply's remembered layout and jumps the reader on recovery. Either way its incoming contents win, including a rewind
// point withdrawn by the daemon. Only rows from a sandbox older than row ids, and unnamed, match by content; anything
// unmatched is allocated above every id standing.
const contentKey = (message: Omit<ChatMessage, "id">): string => JSON.stringify(message);
const rowKey = (message: Omit<ChatMessage, "id">): string => {
    if (message.rowId !== undefined) {
        return JSON.stringify([`row`, message.rowId]);
    }
    return message.role === `user` && message.messageId !== undefined ? JSON.stringify([`user`, message.messageId]) : contentKey(message);
};
// Whether a key names its row rather than spelling out its contents, so a match on it says nothing about them.
const namedRow = (message: Omit<ChatMessage, "id">): boolean => message.rowId !== undefined || (message.role === `user` && message.messageId !== undefined);

// The row a named match keeps: the standing object where nothing changed, else the incoming contents under its id.
const keepingId = (same: ChatMessage, row: Omit<ChatMessage, "id">): ChatMessage => {
    const { id, ...content } = same;
    return contentKey(content) === contentKey(row) ? same : { ...row, id };
};

export const rebuildKeeping = (standing: readonly ChatMessage[], rows: readonly Omit<ChatMessage, "id">[]): TranscriptState => {
    const kept = new Map<string, ChatMessage[]>();
    let nextId = 1;
    for (const message of standing) {
        const { id, ...content } = message;
        nextId = Math.max(nextId, id + 1);
        const key = rowKey(content);
        const same = kept.get(key);
        if (same === undefined) {
            kept.set(key, [message]);
        } else {
            same.push(message);
        }
    }
    const messages = rows.map((row): ChatMessage => {
        const same = kept.get(rowKey(row))?.shift();
        if (same === undefined) {
            return { ...row, id: nextId++ };
        }
        // A content match already proves equal contents; don't serialise a long reply a second time.
        return namedRow(row) ? keepingId(same, row) : same;
    });
    return { ...emptyTranscriptState, messages, nextId };
};

// The rows of a page of the daemon's record, each knowing where it sits there, counting from the page's own `from`.
export const positioned = (rows: readonly TranscriptRow[], from: number): Omit<ChatMessage, "id">[] =>
    rows.map((row, offset) => ({ ...row, at: from + offset }));

// WHERE THIS WINDOW'S COPY OF THE RECORD ENDS, as the next read of it asks: just past the last row it holds that the
// record does, named by that row's id so the sandbox can tell a record that only grew from one rewound since. Undefined
// when it holds no such row, or that row has no id (a sandbox older than row ids): a whole page is then the way back.
export interface RecordCursor {
    readonly after: number;
    readonly afterRow: string;
}

export const recordCursor = (messages: readonly ChatMessage[]): RecordCursor | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.at !== undefined) {
            return message.rowId === undefined ? undefined : { after: message.at + 1, afterRow: message.rowId };
        }
    }
    return undefined;
};

/* WHAT THE RECORD GAINED, ADDED TO WHAT IS HELD. `rows` carry on from the row named `afterRow` (the cursor this window
   asked with), in the record's order. A row this window already holds under the same id (a live run's row, now
   recorded) takes its recorded copy where it stands and keeps its id, and moves up beside the record's other rows; one
   it never held goes in after the last of them. Whatever else stands below (a live run's rows still unrecorded, this
   window's own notices, words waiting to send) stays below, in its order. Undefined when the row the cursor names is no
   longer held, which only a whole page can mend. */
export const mergeRecorded = (state: TranscriptState, rows: readonly Omit<ChatMessage, "id">[], afterRow: string): TranscriptState | undefined => {
    const anchor = state.messages.findLastIndex((message) => message.rowId === afterRow);
    if (anchor === -1) {
        return undefined;
    }
    if (rows.length === 0) {
        return state;
    }
    const incoming = new Set(rows.flatMap((row) => (row.rowId === undefined ? [] : [row.rowId])));
    const above = state.messages.slice(0, anchor + 1);
    const below = state.messages.slice(anchor + 1);
    // The held copies of incoming rows, by id: taken out of `below` (or replaced in `above`, which a cursor that is
    // honest never needs) as their recorded copies land.
    const held = new Map<string, ChatMessage>();
    for (const message of below) {
        if (message.rowId !== undefined && incoming.has(message.rowId)) {
            held.set(message.rowId, message);
        }
    }
    let nextId = state.nextId;
    const recorded = rows.flatMap((row): ChatMessage[] => {
        const same = row.rowId === undefined ? undefined : held.get(row.rowId);
        if (same !== undefined) {
            return [keepingId(same, row)];
        }
        const standing = row.rowId === undefined ? -1 : above.findIndex((message) => message.rowId === row.rowId);
        if (standing !== -1) {
            above[standing] = keepingId(above[standing]!, row);
            return [];
        }
        return [{ ...row, id: nextId++ }];
    });
    const rest = below.filter((message) => message.rowId === undefined || !held.has(message.rowId));
    const messages = [...above, ...recorded, ...rest];
    const pending = state.pending !== undefined && messages.some((message) => message.id === state.pending!.id) ? state.pending : undefined;
    if (state.attached === undefined) {
        return { messages, nextId, pending };
    }
    // A run still attached keeps counting its patches from its own first row, wherever the merge put it.
    return { messages, nextId, pending, attached: { ...state.attached, base: baseFor(messages, state.attached.run, undefined) } };
};

const mapMessage = (state: TranscriptState, id: number, fn: (message: ChatMessage) => ChatMessage): TranscriptState => ({
    ...state,
    messages: state.messages.map((message) => (message.id === id ? fn(message) : message)),
});

// The attached run.

/* WHERE A RUN'S ROWS BELONG, as the base its head should be drawn over.
   Read off the rows themselves (TranscriptRow.run, stamped by the run that made them), never inferred from their
   content: a live run's last row keeps growing, so a content match fails exactly when it matters and the head lands
   BELOW rows it should have replaced — the prompt again, and its answer again, once per attach, mirrored to disk and
   compounding on the next paint.
   `drawn` covers the one moment no row can: the bubble a send drew ahead of that run's first head. */
const baseFor = (messages: readonly ChatMessage[], run: string, drawn: number | undefined): number => {
    const stamped = messages.findIndex((message) => message.run === run);
    if (stamped >= 0) {
        return stamped;
    }
    const drawnAt = drawn === undefined ? -1 : messages.findIndex((message) => message.id === drawn);
    return drawnAt >= 0 ? drawnAt : messages.length;
};

// The ids of the cards a row holds.
const cardIds = (message: Omit<ChatMessage, "id">): string[] => REQUEST_FIELDS.flatMap((field) => message[field]?.requestId ?? []);

/* ONE CARD, ONE PLACE. A card is answered by its id, so a head that holds one this window already shows above the run
   is that same card moved, never a second: it leaves the row it stood on, and a row it alone made goes with it. The
   daemon brings a parked run back under its own id (turn-resume.ts, carriedRun), which never comes here; an older
   daemon's new run telling the parked prompt again did, and drew the card twice, answerable twice. */
const withoutCards = (messages: readonly ChatMessage[], raised: ReadonlySet<string>): ChatMessage[] =>
    messages.flatMap((message) => {
        if (!cardIds(message).some((id) => raised.has(id))) {
            return [message];
        }
        const stripped: ChatMessage = { ...message };
        for (const field of REQUEST_FIELDS) {
            const card = stripped[field];
            if (card !== undefined && raised.has(card.requestId)) {
                delete stripped[field];
            }
        }
        const said =
            stripped.text.length > 0 ||
            (stripped.thinking?.length ?? 0) > 0 ||
            (stripped.tools?.length ?? 0) > 0 ||
            (stripped.todos?.length ?? 0) > 0;
        return said || cardIds(stripped).length > 0 ? [stripped] : [];
    });

/* TAKE A RUN'S ROWS, WHOLE, from where that run begins: everything below the base is this run's and the head is the
   authority on it, so a transcript that somehow ended up holding the run twice is repaired by the next attach rather
   than carried forward. */
export const attachRun = (state: TranscriptState, head: AttachHead, drawn?: number): TranscriptState => {
    const base = baseFor(state.messages, head.run, drawn);
    const kept = withoutCards(state.messages.slice(0, base), new Set(head.rows.flatMap(cardIds)));
    let nextId = state.nextId;
    const rows = head.rows.map((row, index): ChatMessage => {
        const existing = state.messages[base + index];
        if (existing !== undefined && existing.local !== true) {
            return { ...row, id: existing.id };
        }
        const id = nextId;
        nextId += 1;
        return { ...row, id };
    });
    return { messages: [...kept, ...rows], nextId, pending: undefined, attached: { run: head.run, base: kept.length } };
};

/** Applies one daemon change to the attached run's rows. What it makes of a row is the contract's (patchedRow), the rule
 * the daemon's own fold and record follow; this decides only which row it names, and paces prose for the typewriter. */
export const applyPatch = (state: TranscriptState, patch: TranscriptPatch, typewriter: boolean): TranscriptState => {
    if (patch.op === `append`) {
        return appendMessage(state, patch.row);
    }
    // The row the patch names: by its id where the sandbox names rows (no counting, so a row this window holds above or
    // within the run cannot shift it), else by its index from where the run's rows start. Searched from the end, where
    // a live run writes.
    const named = `rowId` in patch && patch.rowId !== undefined ? state.messages.findLast((message) => message.rowId === patch.rowId) : undefined;
    const target = named ?? state.messages[(state.attached?.base ?? state.messages.length) + patch.index];
    if (target === undefined) {
        return state;
    }
    // A row replaced or dropped already holds its full text: no buffer may go on revealing prose into it.
    const pending = (patch.op === `replace` || patch.op === `drop`) && state.pending?.id === target.id ? undefined : state.pending;
    if (patch.op === `drop`) {
        return { ...state, messages: state.messages.filter((message) => message.id !== target.id), pending };
    }
    if (patch.op === `text` && typewriter) {
        return enqueueText(state, target.id, patch.text);
    }
    return { ...mapMessage(state, target.id, (message) => ({ ...patchedRow(message, patch), id: message.id })), pending };
};

// Typewriter is pure: the caller drives the clock, this only decides what a tick means.

/**
 * Reveals a slice of the buffer, sized to catch up when far behind so a burst types out quickly without a large backlog
 * lagging. A no-op with nothing buffered.
 */
export const revealPending = (state: TranscriptState): TranscriptState => {
    const pending = state.pending;
    if (pending === undefined || pending.text === ``) {
        return state;
    }
    const take = Math.max(2, Math.ceil(pending.text.length / 8));
    const slice = pending.text.slice(0, take);
    const rest = pending.text.slice(take);
    return {
        ...mapMessage(state, pending.id, (message) => ({ ...message, text: `${message.text}${slice}` })),
        pending: rest === `` ? undefined : { id: pending.id, text: rest },
    };
};

/**
 * Reveals the whole buffer at once: a turn ended, was stopped, or a card took the bubble, so nothing may be left
 * mid-type.
 */
export const flushPending = (state: TranscriptState): TranscriptState => {
    const pending = state.pending;
    if (pending === undefined || pending.text === ``) {
        return { ...state, pending: undefined };
    }
    return {
        ...mapMessage(state, pending.id, (message) => ({ ...message, text: `${message.text}${pending.text}` })),
        pending: undefined,
    };
};

// Buffers prose for the typewriter instead of writing it straight to the message. Flushes the prior buffer first if the
// target changed, so nothing leaks across bubbles.
const enqueueText = (state: TranscriptState, id: number, delta: string): TranscriptState => {
    const flushed = state.pending !== undefined && state.pending.id !== id ? flushPending(state) : state;
    return { ...flushed, pending: { id, text: `${flushed.pending?.text ?? ``}${delta}` } };
};
