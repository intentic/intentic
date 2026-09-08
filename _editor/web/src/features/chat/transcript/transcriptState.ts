import type { AttachFrame, TranscriptPatch, TranscriptRow } from "@intentic/sandbox-contract";
import { upsertTool } from "@intentic/sandbox-contract/transcript-fold";
import type { ChatMessage } from "./transcript";

/* THE TRANSCRIPT AS A VALUE, and every transition it can make, as pure functions.
 *
 * What a chat shows is the daemon's rows (transcript-fold.ts folds them from the turn's frames, once, on the
 * daemon) plus the lines this window writes on its own clock. So the transitions here are small: take a run's
 * rows whole when attaching to it, apply the patches that follow, and pace the agent's prose through the
 * typewriter. Nothing here decides what a frame MEANS; that is settled before a byte reaches this window. */

export interface PendingText {
    // The message the buffered text belongs to. Buffered text NEVER migrates: a delta for a different message
    // flushes this one first, or prose leaks across a turn boundary.
    readonly id: number;
    readonly text: string;
}

export interface TranscriptState {
    readonly messages: readonly ChatMessage[];
    // Monotonic message-id allocator. In the state because allocating an id IS a transition, a reducer that
    // reached for a counter on `this` would not be replayable.
    readonly nextId: number;
    readonly pending: PendingText | undefined;
    /* WHERE THE ATTACHED RUN'S ROWS START in this list: the run's row 0 is `messages[base]`, and every patch
     * index counts from there. Remembered with the run's id so that attaching to the SAME run again (a stream
     * that dropped and came back, a tab reopened onto a run still going) replaces the copy this window already
     * holds rather than drawing the answer a second time under it. */
    readonly attached?: { readonly run: string; readonly base: number };
}

export const emptyTranscriptState: TranscriptState = { messages: [], nextId: 1, pending: undefined };

export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

// --- rows this window writes ------------------------------------------------------------------------------------

export const appendMessage = (state: TranscriptState, message: Omit<ChatMessage, "id">): TranscriptState => ({
    ...state,
    messages: [...state.messages, { ...message, id: state.nextId }],
    nextId: state.nextId + 1,
});

const mapMessage = (state: TranscriptState, id: number, fn: (message: ChatMessage) => ChatMessage): TranscriptState => ({
    ...state,
    messages: state.messages.map((message) => (message.id === id ? fn(message) : message)),
});

// --- the attached run -------------------------------------------------------------------------------------------

/* A ROW'S CONTENT AS ONE COMPARABLE VALUE, without the two fields this window adds on top of the daemon's row:
 * the id it hands out, and the mark saying this window wrote the row itself.
 *
 * Fields in a fixed order, and absent ones read the same as undefined ones, because the two sides of every
 * comparison here reach it from different places — the daemon's live head, its record, the local mirror — and a
 * value that went through JSON on the way lost its undefined keys and may have kept its own key order. What they
 * agree on is the content; anything stricter would answer "different" for rows that are the same row. */
const rowKey = (row: TranscriptRow | ChatMessage): string =>
    JSON.stringify(
        Object.entries(row)
            .filter(([key, value]) => value !== undefined && key !== `id` && key !== `local`)
            .sort(([left], [right]) => (left < right ? -1 : 1)),
    );

/* WHAT OF THIS RUN THE TRANSCRIPT IS ALREADY SHOWING, as the base its rows should be drawn over.
 *
 * A window remembers where it put a run BY ID (`attached`), and three ordinary things drop that memory while
 * keeping the messages: a paint from the local mirror (transcriptClock's `adopt`), a redraw from the daemon's
 * record (`rebuild`), and a window that never attached to this run in the first place, which every newly opened
 * one is. The head's rows then arrive with no base to sit at and land at the END of a transcript that is already
 * showing them, drawing the run a second time underneath itself: on a single-turn conversation that is the whole
 * chat twice over, and once more again per hydrate that gets in.
 *
 * So the rows answer it themselves. The LONGEST tail of the transcript that is this head's opening rows, by
 * content, is this run's own work already drawn, and the head replaces it. Nothing matching means none of it is
 * drawn yet — a run found already going, under history that belongs to earlier turns — and the rows go at the end
 * as before. A row this window wrote on its own clock (`local`) is not the daemon's and so never matches, which
 * is what keeps a reclaim from swallowing a notice standing between turns.
 *
 * A false reclaim would need the transcript to END with rows identical to this head's opening ones, and a run
 * opens on its user row, whose `sentAt` no other send shares. */
const reclaimedBase = (messages: readonly ChatMessage[], rows: readonly TranscriptRow[]): number => {
    const most = Math.min(messages.length, rows.length);
    const shown = messages.slice(messages.length - most).map(rowKey);
    const arriving = rows.slice(0, most).map(rowKey);
    for (let taken = most; taken > 0; taken -= 1) {
        if (shown.slice(most - taken).every((key, index) => key === arriving[index])) {
            return messages.length - taken;
        }
    }
    return messages.length;
};

/* TAKE A RUN'S ROWS, WHOLE. The head carries the run's transcript so far, so attaching is a replacement, never a
 * merge: everything from the run's base is this run's, and the base is where this window last put this very run
 * (re-attaching), else the bubble this window drew ahead of the head (`drawn`, the send path's own user bubble),
 * else wherever the transcript is already showing this run's rows (`reclaimedBase`, which answers with the end of
 * what it holds when none of them are). Ids are kept by position, so that bubble keeps its id when the daemon's
 * row replaces it, and anything answered by id stays answered. */
export const attachRun = (state: TranscriptState, head: AttachHead, drawn?: number): TranscriptState => {
    const drawnAt = drawn === undefined ? -1 : state.messages.findIndex((message) => message.id === drawn);
    const base = state.attached?.run === head.run ? state.attached.base : drawnAt >= 0 ? drawnAt : reclaimedBase(state.messages, head.rows);
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

/** Apply one change the daemon made to the attached run's rows. `typewriter` says whether prose should be paced
 *  (a watched, live transcript) or land whole. */
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
            // The daemon's row is whole, its text included, so prose this window was still revealing for it
            // would land twice: the buffer for that row is dropped, the row already says everything.
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
        case `tool`: {
            const target = at(patch.index);
            return target === undefined
                ? state
                : mapMessage(state, target.id, (message) => ({ ...message, tools: upsertTool(message.tools ?? [], patch.tool, patch.parent) }));
        }
    }
};

// --- typewriter (pure: the caller drives the clock, this owns what a tick means) --------------------------------

/** Reveal a slice of the buffer, sized to catch up when far behind so bursts type out quickly but a large
 *  backlog never lags. Called from the caller's animation frame; a no-op with nothing buffered. */
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

/** Reveal the WHOLE buffer at once, a turn ended, was stopped, or a card took the bubble over, so no text may
 *  be left mid-type. */
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

// Enqueue prose for the typewriter rather than writing it straight to the message. If the target changed (a
// fresh bubble below a card), flush the prior buffer first so nothing leaks across bubbles.
const enqueueText = (state: TranscriptState, id: number, delta: string): TranscriptState => {
    const flushed = state.pending !== undefined && state.pending.id !== id ? flushPending(state) : state;
    return { ...flushed, pending: { id, text: `${flushed.pending?.text ?? ``}${delta}` } };
};
