/* WHY THE FOCUSED CHAT MOVED, the trace behind the one report that keeps coming back and has never been
 * reproduced here: the floating chat showing a different session than the board's ring, after a click on the
 * board that both of them were supposed to hear.
 *
 * Everything that can move the focus goes through ONE writer (setConversations in useChat), so one line there,
 * plus the surfaces that ask it to move, is the whole causal chain:
 *
 *   select · the click, naming the id it asked for
 *   → open-agent / open-session · whether that id was already a tab or had to be minted
 *   → focus · what the writer RESOLVED it to, which is not always what was asked (an id that names no open tab
 *     is not written; the focus falls to the last one instead, a silent divergence that looks exactly like the
 *     report), plus anything the same write swept
 *   → render · which conversation the panel actually put on screen, and in WHICH window
 *
 * Read together those four lines say whether a divergence is the store's (the resolved focus was already
 * wrong) or the screen's (the store was right and the pixels are stale), the split every previous round of
 * this had to guess at.
 *
 * Always on, and cheap by construction: these are user-scale events (a click, a close, a reconnect), not
 * per-frame ones, so a busy hour is a few hundred lines. Each window keeps and prints its OWN ring, because
 * each runs its own copy of the app (composables/floating.ts), and the report worth tracing is precisely a
 * disagreement BETWEEN two of them: the `render` line names which window it came from (`floating` or `docked`),
 * so the two rings read as one story once both are pasted. `window.intenticFocusTrace()` dumps a ring as one
 * block, for the usual case where nobody had DevTools open when it happened. */

// Long enough to cover the minutes before someone notices and opens the console, short enough to paste.
const KEPT = 300;

interface FocusEntry {
    readonly at: number;
    readonly what: string;
    readonly detail: Record<string, unknown>;
}

const entries: FocusEntry[] = [];

const stamp = (at: number): string => new Date(at).toISOString().slice(11, 23);

const line = (entry: FocusEntry): string =>
    `${stamp(entry.at)}  ${entry.what.padEnd(16)} ${Object.entries(entry.detail)
        .map(([key, value]) => `${key}=${typeof value === `string` ? value : JSON.stringify(value)}`)
        .join(` `)}`;

export const traceFocus = (what: string, detail: Record<string, unknown>): void => {
    const entry = { at: Date.now(), what, detail };
    entries.push(entry);
    if (entries.length > KEPT) {
        entries.shift();
    }
    console.info(`[intentic focus] ${line(entry)}`);
};

declare global {
    interface Window {
        /** The trace as one pasteable block, see focusTrace.ts. */
        intenticFocusTrace?: () => string;
    }
}

if (typeof window !== `undefined`) {
    window.intenticFocusTrace = (): string => entries.map(line).join(`\n`);
}
