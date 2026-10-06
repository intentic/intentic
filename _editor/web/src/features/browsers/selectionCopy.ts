import { writeClipboard } from "@intentic/ui/clipboard";
import type { KeyFrame } from "./keyIntent";

// Ctrl+C over a remote Chromium's picture. Copying inside that browser lands on the sandbox's clipboard, unreadable by
// the user's machine, so the page's selection is asked for over the socket and written to the user's own here. The
// chord still reaches the page afterwards, never before, since a cut running first would delete the text being read.
// Shared by the agent's browser view and a connected account's browser window.

// How long a Ctrl+C waits for the page's selection before the keystroke goes through anyway.
const SELECTION_TIMEOUT_MS = 1500;

export interface SelectionCopy {
    // `from` is the element the keystroke landed on: the write goes through its window (clipboardOf).
    readonly copyOut: (chord: KeyFrame, from?: Element | null) => Promise<void>;
    // The daemon's `selection` frame.
    readonly answer: (text: string | undefined) => void;
    // A copy waiting on a socket that's going away resolves empty rather than hanging until its timeout.
    readonly cancel: () => void;
}

// What this says on the socket: the question, and the chord once it is answered.
export type SelectionMessage = { readonly type: `selection` } | KeyFrame;

export const selectionCopy = (send: (message: SelectionMessage) => void): SelectionCopy => {
    // The Ctrl+C in flight; one at a time, since a second press before the first resolves is the same question twice.
    let pending: ((text: string) => void) | undefined;

    const answer = (text: string | undefined): void => {
        pending?.(text ?? ``);
        pending = undefined;
    };

    // The timeout keeps a slow tunnel from stranding the keystroke.
    const askSelection = (): Promise<string> =>
        new Promise((resolve) => {
            pending?.(``);
            pending = resolve;
            send({ type: `selection` });
            window.setTimeout(() => {
                if (pending === resolve) {
                    pending = undefined;
                    resolve(``);
                }
            }, SELECTION_TIMEOUT_MS);
        });

    return {
        copyOut: async (chord, from) => {
            const text = await askSelection();
            if (text !== ``) {
                // A refused or unavailable clipboard must not eat the keystroke.
                await writeClipboard(text, from);
            }
            send(chord);
        },
        answer,
        cancel: () => answer(``),
    };
};
