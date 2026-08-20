/* THE QUESTION CARD'S PICKS, OUTLIVING ITS COMPONENT. An AskUserQuestion card parks the turn until the user
 * answers, and answering is often the slow part, the user goes to read the code the question is about, or the
 * tab reloads under them. The run itself is daemon-side, so the card comes back pending on reattach; only the
 * half-made choice living in ChatMessageView's refs died with the page. Clicking the same three options over
 * again is exactly the kind of work nobody agreed to redo.
 *
 * Keyed by requestId, the daemon's UUID for the parked card (see agent-requests.ts), which is what the replayed
 * frame carries too, so the draft finds its way back to the same card and to no other. localStorage rather than
 * the daemon: this is a client-side picking convenience, and it belongs to the window doing the picking, not to
 * the run. Drafts are dropped the moment the card stops being pending (answered, dismissed, or the turn stopped
 * out from under it); the age sweep below is for the cards that never got that far, because the tab closed. */

const PREFIX = `intentic.questionDraft.`;

// Long enough that a question left open over a weekend still has its picks; short enough that abandoned cards
// don't accumulate in a storage bucket nothing else prunes.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* The free-text row's stand-in inside `selections`. "Other" is one of the card's OPTIONS rather than a second
 * widget standing beside them, which is what lets the card hold a single list of picks instead of two
 * half-states that have to be kept agreeing with each other. The sentinel carries a NUL so it can never
 * collide with a label the agent wrote, and it is persisted, so it has to stay stable across builds. */
export const OTHER_LABEL = `\u0000other`;

export interface QuestionDraft {
    // Selected option label(s) per question index, matching the card's own indexing. OTHER_LABEL stands for
    // the free-text row.
    readonly selections: Record<number, string[]>;
    // What was typed into the free-text row, per question index. Payload, not a pick: text alone answers
    // nothing until OTHER_LABEL is among that question's selections.
    readonly otherTexts: Record<number, string>;
}

// As much of a live question as replaying a draft into it needs: which picks that card would still accept.
export interface DraftQuestionShape {
    readonly multiSelect: boolean;
    readonly options: readonly { readonly label: string }[];
}

interface StoredDraft extends QuestionDraft {
    readonly savedAt: number;
}

const EMPTY: QuestionDraft = { selections: {}, otherTexts: {} };

const key = (requestId: string): string => `${PREFIX}${requestId}`;

/* A draft is replayed into a LIVE card, so it may only carry picks that card would still accept. Two things put
 * stored picks out of step with the question they came from: a build whose card had different rules (before
 * "Other" was an option, a listed pick and a typed answer could be held at the same time), and a single-select
 * question holding more than the one pick it allows. Both resolve the same way, keep the first pick that is
 * still legal, drop the rest, so a reopened card can never show a combination the user could not have reached
 * by clicking. Typed text always survives: it is the Other row's payload rather than a pick of its own, and
 * nothing is won by throwing away words the user wrote. */
const normalize = (draft: QuestionDraft, questions: readonly DraftQuestionShape[]): QuestionDraft => {
    const selections: Record<number, string[]> = {};
    questions.forEach((question, index) => {
        const legal = (draft.selections[index] ?? []).filter(
            (label) => label === OTHER_LABEL || question.options.some((option) => option.label === label),
        );
        const picks = question.multiSelect ? legal : legal.slice(0, 1);
        if (picks.length > 0) {
            selections[index] = picks;
        }
    });
    return { selections, otherTexts: draft.otherTexts };
};

export const readQuestionDraft = (requestId: string, questions: readonly DraftQuestionShape[]): QuestionDraft => {
    try {
        const raw = localStorage.getItem(key(requestId));
        if (raw === null) {
            return EMPTY;
        }
        const stored = JSON.parse(raw) as StoredDraft;
        return normalize({ selections: stored.selections ?? {}, otherTexts: stored.otherTexts ?? {} }, questions);
    } catch {
        // Storage unavailable (private mode) or a draft this build can't read: the card just starts empty,
        // which is where it started before any of this existed.
        return EMPTY;
    }
};

export const writeQuestionDraft = (requestId: string, draft: QuestionDraft): void => {
    const stored: StoredDraft = { ...draft, savedAt: Date.now() };
    try {
        localStorage.setItem(key(requestId), JSON.stringify(stored));
    } catch {
        // Storage unavailable or full; the in-memory picks still hold for this page.
    }
};

export const clearQuestionDraft = (requestId: string): void => {
    try {
        localStorage.removeItem(key(requestId));
    } catch {
        // Nothing to do, an unwritable bucket has nothing to clear either.
    }
};

// Drop drafts for cards that were never settled in this browser (the tab closed on a pending question, the run
// ended elsewhere). Runs once when the chat module first loads, off the render path.
const sweep = (): void => {
    try {
        const cutoff = Date.now() - MAX_AGE_MS;
        const stale = Object.keys(localStorage).filter((storageKey) => {
            if (!storageKey.startsWith(PREFIX)) {
                return false;
            }
            try {
                const stored = JSON.parse(localStorage.getItem(storageKey) ?? `{}`) as Partial<StoredDraft>;
                return (stored.savedAt ?? 0) < cutoff;
            } catch {
                // Unparseable entry under our prefix is dead weight by definition.
                return true;
            }
        });
        for (const storageKey of stale) {
            localStorage.removeItem(storageKey);
        }
    } catch {
        // Storage unavailable; there is nothing to sweep.
    }
};

sweep();
