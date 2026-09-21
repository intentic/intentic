// Assigns every keystroke over a live browser picture (useBrowserView, BrowserProfileDialog) to the host, the remote
// page, or the chrome the client draws itself.
// - Command: what a browser's own shortcuts do (new tab, close tab, reload, back, the address bar, find); the
//   chrome is the client's, so these never travel as keystrokes, which is also what keeps Ctrl+L from focusing an
//   omnibox the picture does not show.
// - Host: window-level shortcuts a remote Chromium ignores anyway (devtools, a new window); paste, since the remote
//   clipboard is the sandbox's own, not the user's.
// - Page: typing, control keys, and editing chords (select-all, undo, redo).
// - clipboard: copy/cut, which round-trip the selection to the user's own clipboard instead of just reaching the
//   sandbox's.

// Sent as key events; everything else printable is an insert (see the daemon's SPECIAL_KEYS). Space is the one
// printable sent as a key, so a focused button or checkbox answers it.
const CONTROL_KEYS = new Set([
    `Enter`,
    `Backspace`,
    `Tab`,
    `Delete`,
    `Insert`,
    `Escape`,
    `ArrowLeft`,
    `ArrowRight`,
    `ArrowUp`,
    `ArrowDown`,
    `Home`,
    `End`,
    `PageUp`,
    `PageDown`,
    ` `,
]);

// Editing chords sent to the page: select all, undo, redo, and the rich-text trio a comment box uses.
const EDITING_LETTERS = new Set([`a`, `z`, `y`, `b`, `i`, `u`]);
// The two that also have to reach the user's own clipboard.
const CLIPBOARD_LETTERS = new Set([`c`, `x`]);
// Chords built on a control key rather than a letter: word-wise motion, selection to an edge, word delete.
const CHORD_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `Backspace`, `Delete`]);

export type BrowserCommand = `newTab` | `closeTab` | `reload` | `back` | `forward` | `address` | `find` | `nextTab` | `prevTab`;

// Primary-modifier letters that are the browser's, by what they do.
const COMMAND_LETTERS: ReadonlyMap<string, BrowserCommand> = new Map([
    [`t`, `newTab`],
    [`w`, `closeTab`],
    [`r`, `reload`],
    [`l`, `address`],
    [`f`, `find`],
]);

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
    // The chrome's own verb; never a keystroke.
    | { readonly kind: `command`; readonly command: BrowserCommand }
    // Not ours: the host app and the user's own browser keep default behaviour.
    | { readonly kind: `device` };

const host: KeyIntent = { kind: `device` };
const command = (name: BrowserCommand): KeyIntent => ({ kind: `command`, command: name });

// Sent lower-case; Shift travels as a flag and the far end decides the resulting character (Ctrl+Shift+Z is a redo
// whose key is "Z").
const keyFrame = (event: KeyboardEvent, ctrl: boolean, key?: string): KeyFrame => ({
    type: `key`,
    key: key ?? event.key,
    ...(ctrl ? { ctrl: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
});

// A primary-modifier letter: the browser's verbs, the clipboard pair, the editing chords, and the rest the host's.
const letterIntent = (event: KeyboardEvent, letter: string): KeyIntent => {
    // Paste, and every window-level shortcut, stay with the host.
    if (letter === `v`) {
        return host;
    }
    // Ctrl+Shift+<letter> is the browser's own shortcuts (devtools, reopen tab, new incognito window); redo is the
    // one exception, since it belongs to whatever field has the caret.
    if (event.shiftKey && letter !== `z`) {
        return host;
    }
    const verb = COMMAND_LETTERS.get(letter);
    if (verb !== undefined) {
        return command(verb);
    }
    if (CLIPBOARD_LETTERS.has(letter)) {
        return { kind: `clipboard`, frame: keyFrame(event, true, letter) };
    }
    return EDITING_LETTERS.has(letter) ? { kind: `key`, frame: keyFrame(event, true, letter) } : host;
};

// Tab cycling: Ctrl+Tab and Ctrl+PageDown go forward, with Shift or PageUp back.
const TAB_CYCLE: ReadonlyMap<string, BrowserCommand> = new Map([
    [`Tab`, `nextTab`],
    [`PageDown`, `nextTab`],
    [`PageUp`, `prevTab`],
]);

// What a primary-modifier chord means; the letter rules are the same on the page as in a form.
const chordIntent = (event: KeyboardEvent): KeyIntent => {
    const cycle = TAB_CYCLE.get(event.key);
    if (cycle !== undefined) {
        return command(event.shiftKey && cycle === `nextTab` ? `prevTab` : cycle);
    }
    if (event.key.length === 1) {
        return letterIntent(event, event.key.toLowerCase());
    }
    // Word-wise motion and selection to an edge: Shift is welcome here, and required.
    return CHORD_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, true) } : host;
};

// `primary` is Ctrl on Windows/Linux and Cmd on a Mac, the same chord in a person's hands, sent as the same `ctrl`
// on the wire.
export const keyIntent = (event: KeyboardEvent): KeyIntent => {
    // Alt chords are history navigation, or the host's (menus); they mean almost nothing in a page.
    if (event.altKey) {
        if (event.key === `ArrowLeft` || event.key === `ArrowRight`) {
            return command(event.key === `ArrowLeft` ? `back` : `forward`);
        }
        return host;
    }
    if (event.ctrlKey || event.metaKey) {
        return chordIntent(event);
    }
    if (event.key === `F5`) {
        return command(`reload`);
    }
    // Shift is already applied to the character, so a capital needs no frame; only the control keys need one, and
    // need Shift to avoid a selection collapsing to a caret move.
    if (event.key.length === 1 && event.key !== ` `) {
        return { kind: `text`, text: event.key };
    }
    return CONTROL_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, false) } : host;
};
