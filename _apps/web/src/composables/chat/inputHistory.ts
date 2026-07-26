/* Composer message recall — what the user has SENT, cycled back into the composer with ↑ / ↓, the way a shell
 * cycles its command history. Distinct from the transcript: the transcript is one conversation's record and is
 * already on screen, while recall is workspace-wide and its whole point is reaching a prompt from a chat that
 * is no longer open ("run the tests", "review the diff") without retyping it.
 *
 * Scoped per sandbox, alongside the tab snapshot in useChat: the prompts worth recalling are properties of the
 * workspace, and mixing two sandboxes' prompts into one list would make the ring mostly noise. localStorage
 * rather than the daemon — this is a client-side typing convenience, and it must work before a sandbox is
 * reachable (the composer is usable while the tunnel wakes). */

const historyKey = (sandboxId: string): string => `intentic.inputHistory.${sandboxId}`;

// The ring's depth. Deep enough that yesterday's prompt is still reachable, shallow enough that the whole list
// stays inside the synchronous localStorage budget the tab snapshot already shares.
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
        // Storage full or blocked (private mode): recall degrades to this page's lifetime, which is still the
        // useful half of the feature. Failing the send over a typing convenience would not be.
    }
};

/* Whether the caret sits on the first / last line of the draft. These gate the arrows so recall claims a key
 * only when the caret has nowhere left to go in that direction — which is what lets a recalled MULTI-LINE
 * message still be navigated and edited natively before it is sent. */
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

    // Whether there is anything to recall — the composer's hint advertises ↑ only once the ring is non-empty.
    get recallable(): boolean {
        return this.entries.length > 0;
    }

    // Record a sent message. Consecutive duplicates are dropped — re-running the same prompt three times should
    // cost one slot in the ring, not three presses of ↑ to get past it.
    record(text: string): void {
        const entry = text.trim();
        if (entry === `` || this.entries[this.entries.length - 1] === entry) {
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

    // Step to the older entry, stashing `draft` on the first step. Undefined when there is nothing to recall
    // (an empty ring, or already at the oldest entry) — the caller then leaves the key to the browser.
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

    // Drop recall state without touching the composer — for a send, a keystroke, or a tab switch, all of which
    // mean the text on screen is the user's again and the stashed draft is no longer anyone's to restore.
    reset(): void {
        this.cursor = undefined;
        this.stash = ``;
    }
}

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
