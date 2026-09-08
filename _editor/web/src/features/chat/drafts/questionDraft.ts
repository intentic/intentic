// Picks for an AskUserQuestion card, kept outside its component so they survive a reload while the run (daemon-side)
// stays parked. Keyed by requestId, matching the replayed frame, so a draft finds its own card and no other. Dropped
// once the card stops being pending; the age sweep below catches the ones a closed tab left behind.

const PREFIX = `intentic.questionDraft.`;

// Long enough for a weekend-old question; short enough that abandoned cards don't pile up.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Free-text row's stand-in in `selections`, NUL-prefixed against agent labels; persisted, so kept stable.
export const OTHER_LABEL = `\u0000other`;

export interface QuestionDraft {
    // Selected option label(s) per question index; OTHER_LABEL stands for the free-text row.
    readonly selections: Record<number, string[]>;
    // Typed text for the free-text row, per question index; not a pick until OTHER_LABEL is selected.
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

// A draft replays into a live card, so only picks that card would still accept survive: the first still-legal
// pick per question, the rest dropped. Typed text always survives; it is the Other row's payload, not a pick.
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
        // Storage unavailable or a draft this build can't read: the card starts empty.
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
        // Nothing to do; an unwritable bucket has nothing to clear either.
    }
};

// Drops drafts for cards never settled in this browser (a closed tab, a run that ended elsewhere). Runs once
// at module load, off the render path.
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
                // Unparseable entry under this prefix is dead weight by definition.
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
