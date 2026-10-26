import { isApplePlatform, letterOfCode } from "@intentic/ui/keys";

// Routes live-browser keystrokes: Command handles tabs, reload, back, address bar and find in the client's own chrome.
// Host keeps window shortcuts and paste, whose clipboard belongs to the user; Page gets typing, control keys and editing chords.
// clipboard round-trips copy/cut selections to the user's clipboard. Command shortcuts never reach the remote omnibox.

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
    // A keystroke for the page, chord or not; `after` a second one, for a Mac edit Linux spells in two.
    | { readonly kind: `key`; readonly frame: KeyFrame; readonly after?: KeyFrame }
    // Reads the selection before the page sees the chord; a cut running first would delete the text being read.
    | { readonly kind: `clipboard`; readonly frame: KeyFrame }
    // The chrome's own verb; never a keystroke.
    | { readonly kind: `command`; readonly command: BrowserCommand }
    // Not ours: the host app and the user's own browser keep default behaviour.
    | { readonly kind: `device` };

const host: KeyIntent = { kind: `device` };

/** The keystrokes a page is sent for one intent, in order. */
export const keyFrames = (intent: Extract<KeyIntent, { kind: `key` }>): readonly KeyFrame[] =>
    intent.after === undefined ? [intent.frame] : [intent.frame, intent.after];
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

// A Mac's text keys as the Linux page spells them. ⌘ with an arrow reaches the line's or the document's edge, and ⌥ with
// one a word; ⌘⌫ deletes to the line's start and ⌥⌫ a word; ⌃ with A, E, B, F, N, P, D or H is the Emacs motion every
// Mac field answers. Shift rides along, so a selection still extends. Without this, ⌘← moved a word and ⌥← went Back.
const MAC_COMMAND_EDGES = new Map([
    [`ArrowLeft`, { key: `Home`, ctrl: false }],
    [`ArrowRight`, { key: `End`, ctrl: false }],
    [`ArrowUp`, { key: `Home`, ctrl: true }],
    [`ArrowDown`, { key: `End`, ctrl: true }],
]);
const MAC_CONTROL_MOTIONS = new Map([
    [`a`, `Home`],
    [`e`, `End`],
    [`b`, `ArrowLeft`],
    [`f`, `ArrowRight`],
    [`n`, `ArrowDown`],
    [`p`, `ArrowUp`],
    [`d`, `Delete`],
    [`h`, `Backspace`],
]);
const MAC_WORD_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `Backspace`, `Delete`]);

const commandIntent = (event: KeyboardEvent): KeyIntent | undefined => {
    const edge = MAC_COMMAND_EDGES.get(event.key);
    if (edge !== undefined) {
        return { kind: `key`, frame: keyFrame(event, edge.ctrl, edge.key) };
    }
    if (event.key === `Backspace` || event.key === `Delete`) {
        // Select to the line's edge, then delete the selection: Linux has no one key for it.
        const edgeKey = event.key === `Backspace` ? `Home` : `End`;
        return { kind: `key`, frame: { type: `key`, key: edgeKey, shift: true }, after: { type: `key`, key: event.key } };
    }
    // Safari's and Chrome's Back and Forward on a Mac.
    return event.key === `[` || event.key === `]` ? command(event.key === `[` ? `back` : `forward`) : undefined;
};

// What a Mac means where it differs from the shared reading below, or undefined where it doesn't.
const macIntent = (event: KeyboardEvent): KeyIntent | undefined => {
    const { metaKey, altKey, ctrlKey } = event;
    if (metaKey && !altKey && !ctrlKey) {
        return commandIntent(event);
    }
    if (altKey && !metaKey && !ctrlKey) {
        if (MAC_WORD_KEYS.has(event.key)) {
            return { kind: `key`, frame: keyFrame(event, true) };
        }
        // Option types a letter of its own (ą, ß, é on a Mac's layouts): a character for the page, never a chord.
        return [...event.key].length === 1 ? { kind: `text`, text: event.key } : host;
    }
    if (ctrlKey && !metaKey && !altKey) {
        const motion = MAC_CONTROL_MOTIONS.get(letterOfCode(event.code) ?? event.key.toLowerCase());
        // The rest of ⌃ (⌃K's kill, ⌃T's transpose) has no Linux twin, and stays with the host.
        return motion === undefined ? host : { kind: `key`, frame: keyFrame(event, false, motion) };
    }
    return undefined;
};

// `primary` is Ctrl on Windows/Linux and Cmd on a Mac, the same chord in a person's hands, sent as the same `ctrl`
// on the wire.
export const keyIntent = (event: KeyboardEvent, isMac: boolean = isApplePlatform()): KeyIntent => {
    const mac = isMac ? macIntent(event) : undefined;
    if (mac !== undefined) {
        return mac;
    }
    // Alt chords are history navigation, or the host's (menus); they mean almost nothing in a page.
    if (event.altKey) {
        if (event.key === `ArrowLeft` || event.key === `ArrowRight`) {
            return command(event.key === `ArrowLeft` ? `back` : `forward`);
        }
        return host;
    }
    // allow(modifier-tiers): the page is Linux, where ⌘ on a Mac and Ctrl on a PC are both its Ctrl.
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
