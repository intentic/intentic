import { cancelledCards, holdsCard, type TranscriptRow } from "@intentic/sandbox-contract";
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

/* Older retries recorded the restored checklist even when the provider refused before doing any work.
 * Hide only identical checklist-only copies across notices. Keep the rows in the record and in turn counts
 * so fork/rewind positions remain exact, and preserve every changed list or intervening user/agent message. */
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
            !holdsCard(message) &&
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

/* A file the user attached to a turn, already uploaded to the workspace before send, as the COMPOSER holds it.
 * A row carries the path alone (TranscriptRow.attachments): the name is the path's last segment, and the
 * thumbnail is keyed by path in attachmentPreviews, which every redraw can ask. */
export interface ChatAttachment {
    readonly name: string;
    // Workspace-relative upload path (.intentic/records/artifacts/attachments/<uuid>/<name>).
    readonly path: string;
}

// Freezes any cards a stopped bubble is parked on as `cancelled`, since the aborted stream will never answer them.
// Returns the same message when it holds none, so a Stop only re-renders bubbles that actually changed.
export const withCancelledCards = (message: ChatMessage): ChatMessage => {
    const cards = cancelledCards(message);
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
            holdsCard(message)
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
// duplicate nudge before delivery (Conversation.enqueue).
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
