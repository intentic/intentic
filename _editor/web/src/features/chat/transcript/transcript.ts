import { cancelledRequests, holdsRequest, type TodoItem, type TranscriptRow } from "@intentic/sandbox-contract";
import { formatDate } from "@intentic/ui/format";
import { errandOf } from "../run/errands";

// Transcript vocabulary, independent of how it's produced. A row is the contract's TranscriptRow, folded from a turn's
// frames by the daemon (transcript-fold.ts); this file adds only an id and the mark for a row this window wrote itself.
// Plain value types and pure functions only, no ref, network, or daemon access.

export interface ChatMessage extends TranscriptRow {
    // Stable for the message's life in this window: what a view keys on, and what an answer names.
    readonly id: number;
    // True for a row this window drew, not the daemon's record; recordedRows excludes it, replay never restores it.
    readonly local?: true;
}

/* Older retries recorded the restored checklist even when the provider refused before doing any work. */
export const repeatedChecklistIds = (messages: readonly ChatMessage[]): Set<number> => {
    const hidden = new Set<number>();
    let previous: TranscriptRow["todos"];
    for (const message of messages) {
        if (message.role === `notice`) {
            continue;
        }
        const items = message.role === `assistant` ? message.todos : undefined;
        if (
            items !== undefined &&
            items.length > 0 &&
            previous?.length === items.length &&
            message.text.length === 0 &&
            !message.thinking &&
            !message.tools?.length &&
            !message.attachments?.length &&
            message.usage === undefined &&
            !holdsRequest(message) &&
            items.every((item, index) => {
                const before = previous![index]!;
                return item.content === before.content && item.status === before.status && item.activeForm === before.activeForm;
            })
        ) {
            hidden.add(message.id);
        }
        previous = items;
    }
    return hidden;
};

/* What one checklist snapshot draws. A list is state, not an event: repeating all of it per status flip costs N² lines
   in an N-task turn, so only the turn's first snapshot draws the list and the rest draw what moved since. */
export type ChecklistView = { readonly kind: "full" } | ChecklistDelta;

export interface ChecklistDelta {
    readonly kind: "delta";
    // Items carried whole, not as text: the label depends on whether the bubble is live, which only the view knows.
    readonly finished: readonly TodoItem[];
    readonly started: readonly TodoItem[];
    // Tasks the baton moved on from without completing, which a finished/started pair alone reads as a completion.
    readonly parked: readonly TodoItem[];
    readonly added: number;
    readonly dropped: number;
    // Completed count BEFORE this snapshot: the row states an advance, so its figure can't be read as the list's state now.
    readonly doneBefore: number;
    readonly done: number;
    readonly total: number;
}

const FULL: ChecklistView = { kind: `full` };

// Shared by the deltas that park nothing, so the renderer gets the same array each rebuild, not a fresh equal one.
const NOTHING_PARKED: readonly TodoItem[] = [];

// A snapshot that moved nothing (a TaskList resync restating what is already drawn) has no line to draw at all.
export const changedNothing = (view: ChecklistView): boolean =>
    view.kind === `delta` && view.finished.length === 0 && view.started.length === 0 && view.added === 0 && view.dropped === 0;

// Matched by subject, the only stable field a TodoItem carries; a re-subjected task reads as one dropped and one added.
const deltaOf = (before: readonly TodoItem[], after: readonly TodoItem[]): ChecklistDelta => {
    const was = new Map(before.map((item) => [item.content, item.status]));
    const finished: TodoItem[] = [];
    const started: TodoItem[] = [];
    let added = 0;
    let done = 0;
    for (const item of after) {
        const previous = was.get(item.content);
        was.delete(item.content);
        if (item.status === `completed`) {
            done += 1;
        }
        if (previous === undefined) {
            added += 1;
        }
        if (previous === item.status) {
            continue;
        }
        if (item.status === `completed`) {
            finished.push(item);
        } else if (item.status === `in_progress`) {
            started.push(item);
        }
    }
    // Only where the baton moved: a task that stays active across a snapshot is not news, one left behind by a new
    // start is — it is why the count can hold still while the active row moves on.
    const now = new Map(after.map((item) => [item.content, item]));
    const parked =
        started.length === 0
            ? NOTHING_PARKED
            : before
                  .filter((item) => item.status === `in_progress`)
                  .map((item) => now.get(item.content))
                  .filter((item): item is TodoItem => item !== undefined && item.status !== `completed`);
    const doneBefore = before.filter((item) => item.status === `completed`).length;
    return { kind: `delta`, finished, started, parked, added, dropped: was.size, doneBefore, done, total: after.length };
};

// Keyed by message id; a message absent from the map draws its list in full, so an unmapped snapshot degrades to the
// unabridged rendering rather than to nothing. `repeated` messages are skipped because they are never drawn.
export const checklistViewsOf = (turns: readonly ChatTurn[], repeated: ReadonlySet<number>): Map<number, ChecklistView> => {
    const views = new Map<number, ChecklistView>();
    for (const turn of turns) {
        // Reset per turn, not per conversation: a new prompt re-states the whole list once to orient the reader.
        let previous: readonly TodoItem[] | undefined;
        let latest: number | undefined;
        for (const message of turn.messages) {
            const items = message.role === `assistant` ? message.todos : undefined;
            if (items === undefined || items.length === 0 || repeated.has(message.id)) {
                continue;
            }
            const view = previous === undefined ? FULL : deltaOf(previous, items);
            views.set(message.id, view);
            previous = items;
            if (!changedNothing(view)) {
                latest = message.id;
            }
        }
        // Read top-down, the opening list is the most prominent thing in the turn and the least true by the end of it,
        // with every move after it worth a line. So the turn ENDS on the list too: the last snapshot that moved
        // anything draws in full, which is the one still standing when the reader gets there.
        if (latest !== undefined) {
            views.set(latest, FULL);
        }
    }
    return views;
};

/* A file the user attached to a turn, already uploaded to the workspace before send, as the COMPOSER holds it. */
export interface ChatAttachment {
    readonly name: string;
    // Workspace-relative upload path (.intentic/records/artifacts/attachments/<uuid>/<name>).
    readonly path: string;
}

// Freezes any cards a stopped bubble is parked on as `cancelled`, since the aborted stream will never answer them.
// Returns the same message when it holds none, so a Stop only re-renders bubbles that actually changed.
export const withCancelledCards = (message: ChatMessage): ChatMessage => {
    const cards = cancelledRequests(message);
    return cards === message ? message : { ...message, ...cards };
};

// One exchange: a user prompt and everything produced in reply, up to the next prompt. Grouped so the prompt can pin to
// the scroller's top while its answer scrolls beneath; identified by its opening message's id.
export interface ChatTurn {
    readonly id: number;
    readonly messages: ChatMessage[];
    // Every user message the turn folded in (nudge or errand), rendered as the opener's "↳ …×N" trailer.
    readonly folded: readonly ChatMessage[];
}

// Count of rows the daemon's record holds for these bubbles, the prefix count a fork copies. Excludes `local` rows and
// an opened-but-unwritten bubble, which the daemon drops rather than records.
export const recordedRows = (messages: readonly ChatMessage[]): number =>
    messages.filter((message) => {
        if (message.local === true) {
            return false;
        }
        if (message.role !== `assistant`) {
            return true;
        }
        return (
            message.text.length > 0 ||
            (message.thinking?.length ?? 0) > 0 ||
            (message.tools?.length ?? 0) > 0 ||
            (message.todos?.length ?? 0) > 0 ||
            holdsRequest(message)
        );
    }).length;

// Names the refusal after a denied tool; plain "Continue" would read as re-running the declined command.
export const CONTINUATIONS = {
    plain: `Continue`,
    afterDenial: `Continue, without the step I declined.`,
} as const;

// Normalizes to lower case, single-spaced, with trailing "."/"!"/"…" stripped; a trailing "?" is kept, since
// "continue?" asks rather than consents.
const bareText = (text: string): string =>
    text
        .trim()
        .toLowerCase()
        .replace(/[.!…]+$/u, ``)
        .trim()
        .replace(/\s+/gu, ` `);

// Matched against the whole message, so "continue, but skip the tests" still pins as a real instruction.
const ACKNOWLEDGMENTS = new Set([
    ...Object.values(CONTINUATIONS).map(bareText),
    `continue`,
    `please continue`,
    `keep going`,
    `go`,
    `go on`,
    `go ahead`,
    `go for it`,
    `carry on`,
    `proceed`,
    `resume`,
    `next`,
    `do it`,
    `do that`,
    `yes`,
    `yes please`,
    `y`,
    `yep`,
    `yeah`,
    `ok`,
    `okay`,
    `k`,
    `sure`,
    `sounds good`,
    `lgtm`,
    `ship it`,
    `approved`,
    `+1`,
    `👍`,
]);

// Text-only check, separate from the message-level one: the send queue asks this before a message exists, to catch a
// duplicate nudge before delivery (TurnClient.enqueue).
export const isNudgeText = (text: string): boolean => ACKNOWLEDGMENTS.has(bareText(text));

// An attachment makes any text substantive, "continue" plus a screenshot is new material, not a nudge.
export const isAcknowledgment = (message: ChatMessage): boolean => {
    if (message.role !== `user` || (message.attachments?.length ?? 0) > 0) {
        return false;
    }
    return isNudgeText(message.text);
};

// Reads the last PERMISSION card specifically, not the last card of any kind: a dismissed question or rejected plan
// already carries the user's own words about what to do instead.
export const continuationFor = (messages: readonly ChatMessage[]): string =>
    messages.findLast((message) => message.permission !== undefined)?.permission?.status === `denied`
        ? CONTINUATIONS.afterDenial
        : CONTINUATIONS.plain;

// Two different reasons to fold, both pointing at the prompt above: a bare acknowledgment is the user's own contentless
// nudge, an errand is a prompt the app composed on their behalf (errands.ts).
export const foldsIntoTurn = (message: ChatMessage): boolean => isAcknowledgment(message) || errandOf(message) !== undefined;

// The checklist as it stands now: the last snapshot of the LAST turn only. Scoped that way so a finished turn's list
// keeps standing while the reader looks at it, but an unrelated later prompt clears it instead of pinning a stale one.
export const currentChecklist = (messages: readonly ChatMessage[]): readonly TodoItem[] | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === `user` && !foldsIntoTurn(message)) {
            return undefined;
        }
        if (message.role === `assistant` && (message.todos?.length ?? 0) > 0) {
            return message.todos;
        }
    }
    return undefined;
};

// Shared by turns that fold nothing, so the renderer gets the same array each rebuild, not a fresh equal one.
const NOTHING_FOLDED: readonly ChatMessage[] = [];

export const turnsOf = (messages: readonly ChatMessage[]): ChatTurn[] => {
    const turns: { id: number; messages: ChatMessage[]; folded: readonly ChatMessage[] }[] = [];
    for (const message of messages) {
        const open = turns.at(-1);
        if (open === undefined || (message.role === `user` && !foldsIntoTurn(message))) {
            turns.push({ id: message.id, messages: [message], folded: NOTHING_FOLDED });
            continue;
        }
        open.messages.push(message);
        // Assigned only when there is a folded message, so a turn with none keeps the shared empty array.
        if (message.role === `user`) {
            open.folded = open.folded === NOTHING_FOLDED ? [message] : [...open.folded, message];
        }
    }
    return turns;
};

// Bubble a live turn is writing into, found by scanning back to the last USER row, not the last assistant row anywhere,
// since a later turn's answer already has one above it. A notice is stepped over, not stopped at.
export const liveBubbleOf = (messages: readonly ChatMessage[]): ChatMessage | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const entry = messages[index]!;
        if (entry.role === `user`) {
            return undefined;
        }
        if (entry.role === `assistant`) {
            return entry;
        }
    }
    return undefined;
};

// One cut per turn, hung off the turn it closes rather than opens: a reader finishes an answer and thinks "take it from
// here", not "before this prompt". The value is the message count above the line, the rewind's restore index too.
export const forkCutsOf = (turns: readonly ChatTurn[]): Map<number, number> => {
    const cuts = new Map<number, number>();
    let below = 0;
    for (const turn of turns) {
        below += turn.messages.length;
        cuts.set(turn.id, below);
    }
    return cuts;
};

// Fills gaps the turn-level marks (forkCutsOf) miss, keyed by message id, value is its flat-list index above the line.
// - A folded message (nudge/errand): its turn's own close mark already covers a return here.
// - The conversation's first message: nothing sits above it to fork from.
export const cutsAboveOf = (turns: readonly ChatTurn[]): Map<number, number> => {
    const cuts = new Map<number, number>();
    let index = 0;
    for (const turn of turns) {
        for (const message of turn.messages) {
            if (message.role === `user` && message !== turn.messages[0]) {
                cuts.set(message.id, index);
            }
            index += 1;
        }
    }
    return cuts;
};

// Day a turn was sent on, only where it differs from the last day already shown; taken from the turn's first stamped
// message. Compared as the formatted string in the viewer's zone, not by date arithmetic.
export const dayMarksOf = (turns: readonly ChatTurn[]): Map<number, string> => {
    const marks = new Map<number, string>();
    let marked: string | undefined;
    for (const turn of turns) {
        const sentAt = turn.messages.find((message) => message.sentAt !== undefined)?.sentAt;
        if (sentAt === undefined) {
            continue;
        }
        const day = formatDate(sentAt);
        if (day !== marked) {
            marks.set(turn.id, day);
            marked = day;
        }
    }
    return marks;
};
