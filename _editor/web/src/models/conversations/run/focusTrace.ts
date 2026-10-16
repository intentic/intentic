// Traces why the focused chat moved: select -> open -> focus (what was actually resolved, not always what was asked) ->
// render (what each window shows), so a divergence can be told apart as the store's fault or a stale screen. Always on
// and cheap; each window keeps its own ring, and `window.intenticFocusTrace()` dumps one as a pasteable block.

// Long enough to cover the minutes before someone opens the console; short enough to paste.
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
        /** The trace as one pasteable block. */
        intenticFocusTrace?: () => string;
    }
}

if (typeof window !== `undefined`) {
    window.intenticFocusTrace = (): string => entries.map(line).join(`\n`);
}
