import type { AttachFrame, TranscriptPatch } from "@intentic/sandbox-contract";
import { appendToolThinking, upsertTool } from "@intentic/sandbox-contract/transcript-fold";
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

/* TAKE A RUN'S ROWS, WHOLE, from where that run begins: everything below the base is this run's and the head is the
   authority on it, so a transcript that somehow ended up holding the run twice is repaired by the next attach rather
   than carried forward. */
export const attachRun = (state: TranscriptState, head: AttachHead, drawn?: number): TranscriptState => {
    const base = baseFor(state.messages, head.run, drawn);
    const kept = state.messages.slice(0, base);
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
    return { messages: [...kept, ...rows], nextId, pending: undefined, attached: { run: head.run, base } };
};

/** Applies one daemon change to the attached run's rows. */
export const applyPatch = (state: TranscriptState, patch: TranscriptPatch, typewriter: boolean): TranscriptState => {
    const base = state.attached?.base ?? state.messages.length;
    const at = (index: number): ChatMessage | undefined => state.messages[base + index];
    switch (patch.op) {
        case `append`:
            return appendMessage(state, patch.row);
        case `replace`: {
            const target = at(patch.index);
            if (target === undefined) {
                return state;
            }
            // The daemon's row already has its full text; drop any buffer still revealing prose for it.
            return {
                ...mapMessage(state, target.id, () => ({ ...patch.row, id: target.id })),
                pending: state.pending?.id === target.id ? undefined : state.pending,
            };
        }
        case `drop`: {
            const target = at(patch.index);
            if (target === undefined) {
                return state;
            }
            return {
                ...state,
                messages: state.messages.filter((message) => message.id !== target.id),
                pending: state.pending?.id === target.id ? undefined : state.pending,
            };
        }
        case `text`: {
            const target = at(patch.index);
            if (target === undefined) {
                return state;
            }
            return typewriter
                ? enqueueText(state, target.id, patch.text)
                : mapMessage(state, target.id, (message) => ({ ...message, text: `${message.text}${patch.text}` }));
        }
        case `thinking`: {
            const target = at(patch.index);
            return target === undefined
                ? state
                : mapMessage(state, target.id, (message) => ({ ...message, thinking: `${message.thinking ?? ``}${patch.text}` }));
        }
        case `toolThinking`: {
            const target = at(patch.index);
            return target === undefined
                ? state
                : mapMessage(state, target.id, (message) => ({ ...message, tools: [...appendToolThinking(message.tools ?? [], patch.id, patch.text)] }));
        }
        case `tool`: {
            const target = at(patch.index);
            return target === undefined
                ? state
                : mapMessage(state, target.id, (message) => ({ ...message, tools: upsertTool(message.tools ?? [], patch.tool, patch.parent) }));
        }
    }
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
