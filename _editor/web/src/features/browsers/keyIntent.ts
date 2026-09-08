// Assigns every keystroke over a live browser picture (useBrowserView, BrowserProfileDialog) to the host or the
// remote page.
// - Host: window-level shortcuts a remote Chromium ignores anyway (new tab, reload, devtools); paste, since the
//   remote clipboard is the sandbox's own, not the user's.
// - Page: typing, control keys, and editing chords (select-all, undo, redo).
// - clipboard: copy/cut, which round-trip the selection to the user's own clipboard instead of just reaching the
//   sandbox's.

// Sent as key events; everything else printable is an insert (see the daemon's SPECIAL_KEYS).
const CONTROL_KEYS = new Set([`Enter`, `Backspace`, `Tab`, `Delete`, `Escape`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);

// Editing chords sent to the page: select all, undo, redo, and the rich-text trio a comment box uses.
const EDITING_LETTERS = new Set([`a`, `z`, `y`, `b`, `i`, `u`]);
// The two that also have to reach the user's own clipboard.
const CLIPBOARD_LETTERS = new Set([`c`, `x`]);
// Chords built on a control key rather than a letter: word-wise motion, selection to an edge, word delete.
const CHORD_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `Backspace`, `Delete`]);

// No `meta`: the remote browser is Linux, so a Mac's Cmd is translated to `ctrl` here rather than sent as a
// modifier meaning nothing there.
export interface KeyFrame {
    readonly type: `key`;
    readonly key: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
}

export type KeyIntent =
    // Ordinary typing, insert the character rather than synthesizing a keystroke for it.
    | { readonly kind: `text`; readonly text: string }
    // A keystroke for the page, chord or not.
    | { readonly kind: `key`; readonly frame: KeyFrame }
    // Reads the selection before the page sees the chord; a cut running first would delete the text being read.
    | { readonly kind: `clipboard`; readonly frame: KeyFrame }
    // Not ours: the host app and the user's own browser keep default behaviour.
    | { readonly kind: `host` };

const host: KeyIntent = { kind: `host` };

// Sent lower-case; Shift travels as a flag and the far end decides the resulting character (Ctrl+Shift+Z is a redo
// whose key is "Z").
const keyFrame = (event: KeyboardEvent, ctrl: boolean, key?: string): KeyFrame => ({
    type: `key`,
    key: key ?? event.key,
    ...(ctrl ? { ctrl: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
});

// `primary` is Ctrl on Windows/Linux and Cmd on a Mac, the same chord in a person's hands, sent as the same `ctrl`
// on the wire.
export const keyIntent = (event: KeyboardEvent): KeyIntent => {
    // Alt chords belong to the host (back/forward, menus) and mean almost nothing in a page.
    if (event.altKey) {
        return host;
    }
    const primary = event.ctrlKey || event.metaKey;
    if (!primary) {
        // Shift is already applied to the character, so a capital needs no frame; only the control keys need one, and
        // need
        // Shift to avoid a selection collapsing to a caret move.
        if (event.key.length === 1) {
            return { kind: `text`, text: event.key };
        }
        return CONTROL_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, false) } : host;
    }
    if (event.key.length === 1) {
        const letter = event.key.toLowerCase();
        // Paste, and every window-level shortcut, stay with the host.
        if (letter === `v`) {
            return host;
        }
        // Ctrl+Shift+<letter> is the browser's own shortcuts (devtools, reopen tab, new incognito window); redo is the
        // one
        // exception, since it belongs to whatever field has the caret.
        if (event.shiftKey && letter !== `z`) {
            return host;
        }
        if (CLIPBOARD_LETTERS.has(letter)) {
            return { kind: `clipboard`, frame: keyFrame(event, true, letter) };
        }
        return EDITING_LETTERS.has(letter) ? { kind: `key`, frame: keyFrame(event, true, letter) } : host;
    }
    // Word-wise motion and selection to an edge: Shift is welcome here, and required.
    return CHORD_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, true) } : host;
};
