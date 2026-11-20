import { composingKey, isApplePlatform, letterOfCode } from "@intentic/ui/keys";

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

export type BrowserCommand =
    | `newTab`
    | `closeTab`
    | `reload`
    | `back`
    | `forward`
    | `address`
    | `find`
    | `nextTab`
    | `prevTab`
    | `zoomIn`
    | `zoomOut`
    | `zoomReset`
    | `print`
    | `reopenTab`
    | `history`
    | `downloads`
    | `bookmark`
    | `bookmarksBar`
    | `devtools`
    | `viewSource`;

// Primary-modifier letters that are the browser's, by what they do. Print and bookmark are here so Ctrl+P prints the
// page rather than the editor around it, and Ctrl+D never reaches the host.
const COMMAND_LETTERS: ReadonlyMap<string, BrowserCommand> = new Map([
    [`t`, `newTab`],
    [`w`, `closeTab`],
    [`r`, `reload`],
    [`l`, `address`],
    [`f`, `find`],
    [`p`, `print`],
    [`d`, `bookmark`],
]);
// History and downloads are Ctrl+H and Ctrl+J on Windows and Linux only: ⌘H hides the app on a Mac, and ⌘J is nothing.
const PC_COMMAND_LETTERS: ReadonlyMap<string, BrowserCommand> = new Map([
    [`h`, `history`],
    [`j`, `downloads`],
]);
// The shifted letters that are the browser's own and have an answer here: Ctrl+Shift+T reopens the last closed tab, B
// shows or hides the bookmarks bar, and I, J and C open the developer tools (⌘⇧C too, on a Mac).
const SHIFTED_COMMAND_LETTERS: ReadonlyMap<string, BrowserCommand> = new Map([
    [`t`, `reopenTab`],
    [`b`, `bookmarksBar`],
    [`i`, `devtools`],
    [`j`, `devtools`],
    [`c`, `devtools`],
]);
// ⌘⌥ with a letter on a Mac, read off the physical key since Option changes the character (⌥I is a dead key): the
// developer tools and the page's source. Ctrl+U has no twin here on a PC: it underlines in every rich-text editor, so it
// stays the page's.
const MAC_TOOL_CODES: ReadonlyMap<string, BrowserCommand> = new Map([
    [`KeyI`, `devtools`],
    [`KeyJ`, `devtools`],
    [`KeyC`, `devtools`],
    [`KeyU`, `viewSource`],
]);
// Chromium's zoom chords, by the character they type: `+` is Shift+= on a US layout and a key of its own on others, and
// the numpad's keys report the same characters.
const ZOOM_KEYS: ReadonlyMap<string, BrowserCommand> = new Map([
    [`=`, `zoomIn`],
    [`+`, `zoomIn`],
    [`-`, `zoomOut`],
    [`_`, `zoomOut`],
    [`0`, `zoomReset`],
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
const letterIntent = (event: KeyboardEvent, letter: string, isMac: boolean): KeyIntent => {
    // Paste stays with the host, whose paste event carries the person's own clipboard; every window-level shortcut
    // stays there too.
    if (letter === `v`) {
        return host;
    }
    // Ctrl+Shift+<letter> is the browser's own shortcuts (devtools, new incognito window), reopening a closed tab the
    // one answered here; redo is the other exception, since it belongs to whatever field has the caret.
    if (event.shiftKey && letter !== `z`) {
        const shifted = SHIFTED_COMMAND_LETTERS.get(letter);
        return shifted === undefined ? host : command(shifted);
    }
    const verb = COMMAND_LETTERS.get(letter) ?? (isMac ? undefined : PC_COMMAND_LETTERS.get(letter));
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

// The letter a chord is on: the one the layout types there, or, where that is not a Latin letter (a Cyrillic or Greek
// layout), the one the physical key carries, which is how Chromium reads its own shortcuts on those layouts.
const chordLetter = (event: KeyboardEvent): string => {
    const typed = event.key.toLowerCase();
    return /^[a-z]$/.test(typed) ? typed : (letterOfCode(event.code) ?? typed);
};

// What a primary-modifier chord means; the letter rules are the same on the page as in a form.
const chordIntent = (event: KeyboardEvent, isMac: boolean): KeyIntent => {
    const cycle = TAB_CYCLE.get(event.key);
    if (cycle !== undefined) {
        return command(event.shiftKey && cycle === `nextTab` ? `prevTab` : cycle);
    }
    const zoom = ZOOM_KEYS.get(event.key);
    if (zoom !== undefined) {
        return command(zoom);
    }
    if (characterOf(event.key) !== undefined) {
        return letterIntent(event, chordLetter(event), isMac);
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

// The one character a key typed, or undefined for a named key (`Enter`, `Dead`, `Process`). Counted in code points, so
// an emoji a keyboard sends in one keydown is still one character.
const characterOf = (key: string): string | undefined => ([...key].length === 1 ? key : undefined);

// What the physical key types with no modifier at all, where its code says: a letter or a digit. Undefined for the
// punctuation keys, which move between layouts.
const plainOfCode = (code: string | undefined): string | undefined =>
    letterOfCode(code) ?? (code !== undefined && /^Digit\d$/.test(code) ? code.slice(5) : undefined);

// A character AltGr typed. Windows reports AltGr as Ctrl and Alt held together, so ą on a Polish layout and @ or € on
// a German one arrive as a chord; read as one, they were sent to the host and typed nothing. An engine that reports
// the AltGraph modifier says so outright; elsewhere a Ctrl+Alt key that types something other than its own letter or
// digit (or a character outside ASCII) is AltGr's. A real Ctrl+Alt chord types its own key, `a` on KeyA, and stays one.
const altGraphCharacter = (event: KeyboardEvent): string | undefined => {
    const character = characterOf(event.key);
    if (character === undefined || character === ` ` || event.metaKey) {
        return undefined;
    }
    const plain = plainOfCode(event.code);
    if (plain !== undefined && plain === character.toLowerCase()) {
        return undefined;
    }
    if (event.getModifierState?.(`AltGraph`) === true) {
        return character;
    }
    // Windows spells AltGr as exactly this pair.
    const ctrlAlt = event.ctrlKey && event.altKey;
    // Outside ASCII, or a key whose own character is known and is not this one.
    return ctrlAlt && (plain !== undefined || /[^\x20-\x7e]/u.test(character)) ? character : undefined;
};

// `primary` is Ctrl on Windows/Linux and Cmd on a Mac, the same chord in a person's hands, sent as the same `ctrl`
// on the wire.
export const keyIntent = (event: KeyboardEvent, isMac: boolean = isApplePlatform()): KeyIntent => {
    // An input method is composing (a CJK candidate, a dead key's accent, an Android keyboard's word): the keystroke is
    // the input method's, and what it commits arrives as text on the input sink (inputSink.ts). Enter here confirms the
    // composition; forwarded, it would also submit the remote form.
    if (composingKey(event)) {
        return host;
    }
    const tools = toolsIntent(event, isMac);
    if (tools !== undefined) {
        return tools;
    }
    if (COMPOSING_KEYS.has(event.key)) {
        return host;
    }
    const mac = isMac ? macIntent(event) : undefined;
    if (mac !== undefined) {
        return mac;
    }
    const altGraph = altGraphCharacter(event);
    if (altGraph !== undefined) {
        return { kind: `text`, text: altGraph };
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
        return chordIntent(event, isMac);
    }
    if (event.key === `F5`) {
        return command(`reload`);
    }
    // Shift is already applied to the character, so a capital needs no frame; only the control keys need one, and
    // need Shift to avoid a selection collapsing to a caret move.
    const character = characterOf(event.key);
    if (character !== undefined && character !== ` `) {
        return { kind: `text`, text: character };
    }
    return CONTROL_KEYS.has(event.key) ? { kind: `key`, frame: keyFrame(event, false) } : host;
};

// The names a keydown carries when its character comes later as input, which an input method owns like a keystroke
// mid-composition: `Process` (an IME), `Unidentified` (an Android keyboard), `Dead` (an accent waiting for its letter).
const COMPOSING_KEYS = new Set([`Process`, `Unidentified`, `Dead`]);

// F12 on any platform, and a Mac's ⌘⌥ chords, which are read before a dead key Option made of the letter is taken for
// a composition. The shifted Ctrl chords are letterIntent's.
const toolsIntent = (event: KeyboardEvent, isMac: boolean): KeyIntent | undefined => {
    if (event.key === `F12` && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        return command(`devtools`);
    }
    if (!isMac || !event.metaKey || !event.altKey || event.ctrlKey) {
        return undefined;
    }
    const tool = MAC_TOOL_CODES.get(event.code);
    return tool === undefined ? undefined : command(tool);
};
