// Composer message recall (up/down cycle sent messages, like shell history), distinct from the transcript:
// workspace-wide, reaching prompts from chats no longer open. Scoped per sandbox in localStorage, since it must
// work before the sandbox is reachable.

const historyKey = (sandboxId: string): string => `intentic.inputHistory.${sandboxId}`;

// Ring depth: deep enough for yesterday's prompts, shallow enough to fit the localStorage budget.
const LIMIT = 100;

const read = (key: string): string[] => {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) {
            return [];
        }
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === `string`) : [];
    } catch {
        return [];
    }
};

const write = (key: string, entries: readonly string[]): void => {
    try {
        localStorage.setItem(key, JSON.stringify(entries));
    } catch {
        // Storage full or blocked: recall degrades to this page's lifetime rather than failing the send.
    }
};

// Whether the caret sits on the first/last line of the draft, the only lines where the arrows reach recall.
// Elsewhere the key belongs to the browser, so a multi-line recall stays editable.
export const onFirstLine = (text: string, caret: number): boolean => !text.slice(0, caret).includes(`\n`);
export const onLastLine = (text: string, caret: number): boolean => !text.slice(caret).includes(`\n`);

export class InputHistory {
    // Sent messages, oldest first, capped at LIMIT.
    private entries: string[];
    // Index into `entries` while recall is driving the composer; undefined while it shows the user's own text.
    private cursor: number | undefined;
    // The draft recall displaced, restored by ↓ past the newest entry or by Escape.
    private stash = ``;

    constructor(private readonly key: string) {
        this.entries = read(key);
    }

    // True while the composer is showing a recalled message rather than something the user typed.
    get recalling(): boolean {
        return this.cursor !== undefined;
    }

    // Whether there is anything to recall, the composer's hint advertises ↑ only once the ring is non-empty.
    get recallable(): boolean {
        return this.entries.length > 0;
    }

    // Records a sent message; consecutive duplicates collapse to one slot rather than stacking in the ring.
    record(text: string): void {
        const entry = text.trim();
        if (entry === `` || this.entries.at(-1) === entry) {
            this.reset();
            return;
        }
        this.entries.push(entry);
        if (this.entries.length > LIMIT) {
            this.entries = this.entries.slice(-LIMIT);
        }
        this.reset();
        write(this.key, this.entries);
    }

    // Steps to the older entry, stashing `draft` on the first step. Undefined when there is nothing older to recall.
    previous(draft: string): string | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }
        if (this.cursor === undefined) {
            this.stash = draft;
            this.cursor = this.entries.length - 1;
        } else if (this.cursor > 0) {
            this.cursor -= 1;
        } else {
            return undefined;
        }
        return this.entries[this.cursor];
    }

    // Step to the newer entry, or back to the stashed draft once past the newest. Undefined when not recalling.
    next(): string | undefined {
        if (this.cursor === undefined) {
            return undefined;
        }
        if (this.cursor >= this.entries.length - 1) {
            return this.cancel();
        }
        this.cursor += 1;
        return this.entries[this.cursor];
    }

    // Abandon recall and hand back the displaced draft. Undefined when not recalling.
    cancel(): string | undefined {
        if (this.cursor === undefined) {
            return undefined;
        }
        const draft = this.stash;
        this.reset();
        return draft;
    }

    // Drops recall state without touching the composer text; called on send, keystroke, or tab switch.
    reset(): void {
        this.cursor = undefined;
        this.stash = ``;
    }
}

/* What ↑ / ↓ / Escape do to the composer, or undefined to leave the key to the browser. */
export type RecallStep =
    // Put this text in the composer: a recalled message, or the displaced draft coming back.
    | { readonly kind: `text`; readonly text: string }
    // Move the caret to this offset, leaving the text alone.
    | { readonly kind: `caret`; readonly at: number };

// Arrows first walk the caret to the line's edge; only a press already there recalls history. The caret position
// recall leaves counts as an edge, so repeated presses keep walking the ring.
export const recallStep = (history: InputHistory, key: string, text: string, caret: number): RecallStep | undefined => {
    if (key === `Escape`) {
        const restored = history.cancel();
        return restored === undefined ? undefined : { kind: `text`, text: restored };
    }
    if (key === `ArrowUp` && onFirstLine(text, caret)) {
        if (caret > 0 && !(history.recalling && caret === text.length)) {
            return { kind: `caret`, at: 0 };
        }
        const previous = history.previous(text);
        return previous === undefined ? undefined : { kind: `text`, text: previous };
    }
    if (key === `ArrowDown` && history.recalling && onLastLine(text, caret)) {
        if (caret < text.length) {
            return { kind: `caret`, at: text.length };
        }
        const next = history.next();
        return next === undefined ? undefined : { kind: `text`, text: next };
    }
    return undefined;
};

// One instance per sandbox, so switching back to a sandbox finds the ring it left behind.
const histories = new Map<string, InputHistory>();

export const inputHistoryFor = (sandboxId: string): InputHistory => {
    const existing = histories.get(sandboxId);
    if (existing !== undefined) {
        return existing;
    }
    const history = new InputHistory(historyKey(sandboxId));
    histories.set(sandboxId, history);
    return history;
};
