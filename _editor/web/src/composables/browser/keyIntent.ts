/* WHAT A KEYSTROKE OVER A LIVE BROWSER PICTURE IS FOR — the rule both screencast surfaces follow: the agent's
 * browser view (useBrowserView) and a connected account's own profile window (BrowserProfileDialog). One module
 * because it is one question, and the copy each of them used to carry had already drifted apart in the answer.
 *
 * The picture is a page in another Chromium, but the keyboard belongs to the app around it — so every keystroke
 * has to be assigned to one of them, and BOTH answers are load-bearing:
 *
 *   - Left to the host: the shortcuts a person needs to keep. New tab, close tab, reload, find, print,
 *     devtools. These would be lost to a page that cannot act on them anyway (a remote Chromium driven this way
 *     ignores window-level chords entirely), and swallowing them would make the window a keyboard trap.
 *   - Sent to the page: typing, the control keys a form needs, and the EDITING chords. This is the half that
 *     was missing. Ctrl+A used to fall through to the host, where it selected the entire app instead of the
 *     text in the field the person was looking at — the surest sign that the window had their attention and
 *     not their keyboard.
 *
 * PASTE IS DELIBERATELY NOT ONE OF THEM. The remote Chromium has a clipboard of its own, inside the sandbox,
 * that nothing on the user's machine can write to — so forwarding Ctrl+V would paste whatever that browser last
 * copied rather than what the person meant. It stays with the host, whose paste event carries the real
 * clipboard, and the text rides in as an insert instead (each surface's own onPaste).
 *
 * COPY AND CUT ARE THE SAME PROBLEM POINTING THE OTHER WAY, and need the round trip this file names `clipboard`:
 * the selection is read back out of the remote page and written to the user's own clipboard, because a copy
 * that only reached the sandbox's clipboard would be a copy they can never paste anywhere. */

// Sent as key events; everything else printable rides as an insert (the daemon's SPECIAL_KEYS is the far half
// of this list).
const CONTROL_KEYS = new Set([`Enter`, `Backspace`, `Tab`, `Delete`, `Escape`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);

// Editing chords the remote page gets: select all, undo, redo, and the rich-text trio a comment box uses.
const EDITING_LETTERS = new Set([`a`, `z`, `y`, `b`, `i`, `u`]);
// The two that also have to reach the user's own clipboard.
const CLIPBOARD_LETTERS = new Set([`c`, `x`]);
// Chords built on a control key rather than a letter: word-wise motion, selection to an edge, word delete.
const CHORD_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `Backspace`, `Delete`]);

// A key frame as the wire carries it. No `meta`: the browser at the far end is a Linux one, so a Mac's ⌘ is
// translated to `ctrl` here rather than sent as a modifier that means nothing there.
export interface KeyFrame {
    readonly type: `key`;
    readonly key: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
}

export type KeyIntent =
    // Ordinary typing — insert the character rather than synthesizing a keystroke for it.
    | { readonly kind: `text`; readonly text: string }
    // A keystroke for the page, chord or not.
    | { readonly kind: `key`; readonly frame: KeyFrame }
    // Copy or cut: read the selection back for the user's clipboard FIRST, then let the page have the chord —
    // a cut that ran first would delete the very text being read.
    | { readonly kind: `clipboard`; readonly frame: KeyFrame }
    // Not ours. The host app and the user's own browser keep it, default behaviour and all.
    | { readonly kind: `host` };

const host: KeyIntent = { kind: `host` };

// The letter goes over the wire lower-case; Shift travels as a flag, and the far end decides what character
// that makes (Ctrl+Shift+Z is a redo whose key is "Z").
const keyFrame = (event: KeyboardEvent, ctrl: boolean, key?: string): KeyFrame => ({
    type: `key`,
    key: key ?? event.key,
    ...(ctrl ? { ctrl: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
});

/* Assign one keydown. `primary` is Ctrl on Windows/Linux and ⌘ on a Mac — the same chord in a person's hands,
 * and the same `ctrl` on the wire. */
export const keyIntent = (event: KeyboardEvent): KeyIntent => {
    // Alt chords belong to the host (its own back/forward, its menus) and mean almost nothing in a page.
    if (event.altKey) {
        return host;
    }
    const primary = event.ctrlKey || event.metaKey;
    if (!primary) {
        // Shift is already applied to the character, so a capital arrives as one; only the control keys need a
        // frame of their own, and they need it to carry Shift or a selection would collapse to a caret move.
        if (event.key.length === 1) {
            return { kind: `text`, text: event.key };
        }
        return CONTROL_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, false) } : host;
    }
    if (event.key.length === 1) {
        const letter = event.key.toLowerCase();
        // Paste, and every window-level shortcut, stay with the host — see the note at the top.
        if (letter === `v`) {
            return host;
        }
        /* ADDING SHIFT MAKES IT THE BROWSER'S. Ctrl+Shift+<letter> is where a browser keeps the shortcuts a
         * developer reaches for without looking — devtools, reopen the tab I just closed, new incognito window —
         * and taking those would be a worse theft than the one this module exists to stop. Redo is the one
         * exception, because it belongs to whatever text field has the caret. */
        if (event.shiftKey && letter !== `z`) {
            return host;
        }
        if (CLIPBOARD_LETTERS.has(letter)) {
            return { kind: `clipboard`, frame: keyFrame(event, true, letter) };
        }
        return EDITING_LETTERS.has(letter) ? { kind: `key`, frame: keyFrame(event, true, letter) } : host;
    }
    // Word-wise motion and selection to an edge: Shift is welcome here, and load-bearing.
    return CHORD_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, true) } : host;
};
