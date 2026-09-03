import { cancelledCards, holdsCard, type TranscriptRow } from "@intentic/sandbox-contract";
import { formatDate } from "@intentic/ui/format";
import { errandOf } from "./errands";

/* The transcript VOCABULARY, what a chat is made of, with no notion of how it is produced.
 *
 * A row is the CONTRACT's (TranscriptRow): the daemon folds a turn's frames into rows as they stream and
 * hands every window the rows and the changes to them (transcript-fold.ts), so what this file adds is only
 * what a window needs to draw and address them, an id, and the one mark that tells a row this window wrote
 * from a row the daemon did. Everything here is a plain value type or a pure function over them; nothing
 * reaches for a ref, the network, or the daemon. */

export interface ChatMessage extends TranscriptRow {
    // Stable for the message's life in this window: what a view keys on, and what an answer names.
    readonly id: number;
    /* DRAWN BY THIS WINDOW on the user's own clock rather than by the run: a switch divider, a rewind's line, a
     * failure's guidance, the offer a press armed. Not a row of the daemon's record, which is the one thing
     * that has to be known about it: a fork counts it out (recordedRows), and a replay never brings it back. */
    readonly local?: true;
}

/* A file the user attached to a turn, already uploaded to the workspace before send, as the COMPOSER holds it.
 * A row carries the path alone (TranscriptRow.attachments): the name is the path's last segment, and the
 * thumbnail is keyed by path in attachmentPreviews, which every redraw can ask. */
export interface ChatAttachment {
    readonly name: string;
    // Workspace-relative upload destination (.intentic/records/artifacts/attachments/<uuid>/<name>), sent on the turn.
    readonly path: string;
}

/* Freeze whatever cards a bubble is parked on as `cancelled`, the user stopped the turn out from under the
 * question instead of answering it, and the stream that would have said so was aborted with it. Returns the
 * SAME message when it holds none, so a Stop mid-transcript re-renders only the bubbles it actually changed. */
export const withCancelledCards = (message: ChatMessage): ChatMessage => {
    const cards = cancelledCards(message);
    return cards === message ? message : { ...message, ...cards };
};

// One exchange: the user's prompt and everything the agent produced in reply, up to the next prompt. The
// transcript renders a group per turn so the prompt can pin to the top of the scroller while its answer scrolls
// beneath it, the group is what bounds the pin, so the next prompt pushes this one out instead of stacking on
// it. Identified by its opening message, which is stable for the group's life.
export interface ChatTurn {
    readonly id: number;
    readonly messages: ChatMessage[];
    /* What turnsOf folded into this turn, every user message after the opener, whether the user's own nudge
     * or an errand the app sent (see foldsIntoTurn). Rendered by the opener's bubble as its "↳ … ×N" trailer,
     * so a pinned prompt still admits what has happened to it since.
     *
     * Derived here rather than per render, because the transcript reads it for the head bubble of EVERY turn
     * on every paint of a streaming answer, and a freshly filtered array each time is a changed prop: it
     * defeated Vue's identity bailout and re-rendered one bubble per turn per frame to hand it the same
     * messages back. Turns that folded nothing, nearly all of them, share NOTHING_FOLDED, so the prop holds
     * still across the rebuild `turnsOf` does on each frame. */
    readonly folded: readonly ChatMessage[];
}

/* HOW MANY ROWS THE DAEMON'S RECORD HOLDS FOR THESE BUBBLES, the count a fork hands the daemon so it can copy
 * that prefix of the source conversation. Every row here is the daemon's own except the ones this window wrote
 * on its own clock (ChatMessage.local), and a bubble the run opened and has not written into yet, which the
 * daemon drops rather than records when nothing lands in it. */
export const recordedRows = (messages: readonly ChatMessage[]): number =>
    messages.filter((message) => {
        if (message.local === true) {
            return false;
        }
        if (message.role !== `assistant`) {
            return true;
        }
        return message.text.length > 0 || (message.thinking?.length ?? 0) > 0 || (message.tools?.length ?? 0) > 0 || (message.todos?.length ?? 0) > 0 || holdsCard(message);
    }).length;

/* WHAT PRESSING CONTINUE ACTUALLY SAYS, one sentence, picked from two by continuationFor below.
 *
 * "Continue" alone is ambiguous at exactly the moment it gets used most. The commonest way a turn ends early is
 * a tool the user refused: the agent is told to stop and wait, and the next thing it hears is the word
 * "continue", which reads as "go on then, run it", so the refused command is the first thing it reaches for
 * again. That is the failure mode of typing the word by hand, and naming the refusal is what fixes it.
 *
 * Plain words, and short, because this lands in the transcript as the user's own message: pressing the button IS
 * them saying it. (The machine-voiced resume notes on the wire are for turns the daemon re-ran with nobody
 * asking, where a user bubble would be a lie about who spoke. This is not one of those.) */
export const CONTINUATIONS = {
    plain: `Continue`,
    afterDenial: `Continue, without the step I declined.`,
} as const;

// A message reduced to what the lexicon below is written in: lower case, one space between words, and trailing
// sentence punctuation gone ("Continue.", "ok!"), but never "?", since "continue?" asks rather than consents.
const bareText = (text: string): string =>
    text
        .trim()
        .toLowerCase()
        .replace(/[.!…]+$/u, ``)
        .trim()
        .replace(/\s+/gu, ` `);

/* Messages whose ENTIRE content is "keep going". Such a message points at the previous prompt instead of
 * carrying intent of its own, so opening a turn on it would pin "Continue" to the top of the panel while the
 * question it defers to scrolls away. Matched against the whole message, deliberately: "continue, but skip
 * the tests" carries a new instruction and must pin like any prompt.
 *
 * THE APP'S OWN CONTINUATIONS ARE IN HERE, derived rather than spelled out a second time. They are the same
 * contentless nudge the typed ones are, longer only because they are precise about a refusal the model would
 * otherwise re-attempt, so a chat where the user pressed the button must fold exactly like one where they
 * typed the word, and rewording a sentence up there must never quietly turn it into a message that pins. */
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

/* WORDS THAT ARE ONLY A NUDGE, read off text alone. Separate from the message-level check below because the
 * queue asks this question BEFORE there is a message: a second "carry on" written behind an undelivered first
 * one adds nothing to it, and Conversation.enqueue is where that has to be caught. */
export const isNudgeText = (text: string): boolean => ACKNOWLEDGMENTS.has(bareText(text));

// An attachment makes any text substantive, "continue" plus a screenshot is new material, not a nudge.
export const isAcknowledgment = (message: ChatMessage): boolean => {
    if (message.role !== `user` || (message.attachments?.length ?? 0) > 0) {
        return false;
    }
    return isNudgeText(message.text);
};

/* WHICH CONTINUATION THIS CHAT'S NEXT PRESS SHOULD SEND. The refusal is read off the last PERMISSION card in
 * the transcript rather than the last card of any kind: a dismissed question or a rejected plan already carry
 * the user's own words about what to do instead, so there is nothing for a sentence here to add. */
export const continuationFor = (messages: readonly ChatMessage[]): string =>
    messages.findLast((message) => message.permission !== undefined)?.permission?.status === `denied`
        ? CONTINUATIONS.afterDenial
        : CONTINUATIONS.plain;

/* A USER MESSAGE THAT DOES NOT OPEN A TURN. It folds into the one above it instead, so the prompt that
 * actually defines the work keeps its pin through everything done in service of it.
 *
 * Two populations, deferring for two different reasons, and the split is worth stating because only one of
 * them is about the user at all: a bare acknowledgment is their own contentless "keep going", while an errand
 * is a prompt the APP composed and sent on their behalf (errands.ts), a rebase, a review, a test pass. Both
 * point at the prompt above rather than carrying intent of their own, and pinning either would cover the
 * question it defers to. */
export const foldsIntoTurn = (message: ChatMessage): boolean => isAcknowledgment(message) || errandOf(message) !== undefined;

// A conversation can open with frames that answer no prompt of this session, a restored history's assistant
// text, a provider-switch notice, so the first group may have no user message to pin.
// Shared by every turn that folded nothing, so the overwhelmingly common case hands the renderer the same
// array on each rebuild rather than an equal one (see ChatTurn.folded).
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
        // Every user message past the opener is one this turn folded in. Assigned only when there is one, so a
        // turn that folded nothing keeps the shared empty array.
        if (message.role === `user`) {
            open.folded = open.folded === NOTHING_FOLDED ? [message] : [...open.folded, message];
        }
    }
    return turns;
};

/* WHERE THE CONVERSATION CAN BE CUT, one boundary per turn, keyed by the turn it hangs off (ChatForkCut).
 *
 * A cut is a boundary, and a boundary can be named from either side: "redo this prompt differently" and "carry
 * on from that answer another way" are the same line. Which side it HANGS OFF is not a detail though, it is
 * where the user goes looking for it. The mark used to belong to the turn BELOW the line, level with the prompt
 * the cut ran above, which put every mark one turn away from the answer that prompted the thought and left the
 * first answer in a chat with no mark at all (there is nothing above it to keep). Nobody reads a transcript
 * thinking "before this prompt"; they finish an ANSWER and think "take it from here". So the cut past a turn
 * belongs to that turn: every answer in the chat has a mark of its own, beside the end of what it said.
 *
 * The value is the count of messages a fork there inherits, which is also the index of the message below the
 * line, the next turn's prompt, and therefore the checkpoint a rewind restores. Past the LAST turn there is no
 * message below and no state filed under it, so that cut is the whole conversation carried on elsewhere: the
 * one offer that promises nothing about old files. */
export const forkCutsOf = (turns: readonly ChatTurn[]): Map<number, number> => {
    const cuts = new Map<number, number>();
    let below = 0;
    for (const turn of turns) {
        below += turn.messages.length;
        cuts.set(turn.id, below);
    }
    return cuts;
};

/* THE BOUNDARIES THE MARKS ABOVE DO NOT REACH, keyed by the message each one sits on top of (ChatMessageView).
 *
 * One mark per turn is one boundary per turn, and a turn is not one message. Two kinds of user message end up
 * with no way back to them at all, and both are ordinary rather than exotic:
 *
 *   · A message the turn FOLDED (foldsIntoTurn): a bare "keep going", an errand the app sent on the user's
 *     behalf, a message steered into a running turn. It sits INSIDE a turn, so the mark at that turn's close is
 *     a different line entirely — it keeps everything the fold went on to produce, which is precisely what
 *     someone going back to their "keep going" wants to drop.
 *   · (The first message is deliberately excluded: there is nothing above it to fork from, and a fork glyph
 *     sitting over the date line before any turn read as "fork here" when there is no here yet. Edit is on the
 *     pencil; rewind and file-fork at the head live in the mark at the first answer's close like every other
 *     turn.)
 *
 * Openers past the first are deliberately absent: their boundary IS the previous turn's close, and a second
 * mark on the same line would be two controls doing one thing three pixels apart.
 *
 * The value is the message's index in the flat list, which is what a cut means everywhere else: the count of
 * bubbles kept above the line. Keyed by message id rather than by position because it is read by a component
 * that knows its message and not where it stands, exactly like `doomed` in ChatPane. */
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

/* WHICH DAY A TURN WAS SENT ON, for the turns where that day is not the one already on screen, keyed by turn
 * id, absent for every other turn. The transcript draws one marker row per entry (ChatPane), and that row is
 * the chat's date: it is what lets each prompt's own hover stamp shrink to the clock alone.
 *
 * The day comes off the turn's first STAMPED message, which is its opening prompt, the only row that carries a
 * time (see TranscriptRow.sentAt). A turn with no stamp anywhere (a restored history's opening frames, rows
 * recorded before stamps existed) contributes no marker, and does not break the run either: the next dated turn
 * is compared against the last day actually marked.
 *
 * Days are compared as the FORMATTED string rather than by date arithmetic, in the viewer's own zone: two turns
 * are on the same day exactly when they would print the same marker, which is the only sense of "same day" this
 * is for. */
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
