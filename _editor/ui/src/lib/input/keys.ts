import { t } from "../../i18n/index.js";

// What a keystroke means on the platform it was typed on. A Mac gives ⌘ to the app and ⌃ to text editing and the
// shell, and its text fields answer a set of chords (⌃A, ⌥←, ⌘⌫, …) that Windows and Linux leave unbound; a handler
// that reads "Ctrl or Cmd" as the primary modifier takes those from a Mac user's fingers. Everything here reads the
// platform once per call, so it stays import-safe outside a DOM.

/** Whether this is an Apple platform (macOS, or an iPad or iPhone with a keyboard). */
export const isApplePlatform = (): boolean => /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

type Modifiers = Pick<KeyboardEvent | MouseEvent, `ctrlKey` | `metaKey`>;

/** The primary modifier, held without the other one: ⌘ on Apple, Ctrl elsewhere. ⌃ on a Mac is text editing's. */
export const primaryHeld = (event: Modifiers, isMac: boolean = isApplePlatform()): boolean =>
    isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * Whether this keystroke belongs to an input method that is still composing (a CJK candidate, an accent). Safari ends
 * the composition before it delivers the Enter that confirmed it, so that keydown reads `isComposing: false`; its
 * keyCode is still 229, which every engine reserves for a key the input method consumed.
 */
export const composingKey = (event: Pick<KeyboardEvent, `isComposing` | `keyCode`>): boolean => event.isComposing || event.keyCode === 229;

// Caret motion and deletion that macOS text fields bind under ⌥ or ⌘ (Shift extends the selection, so it stays the
// same chord).
const MAC_TEXT_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Backspace`, `Delete`]);
// The Emacs letters every Cocoa text field answers under ⌃: line start and end, a character back and forward, the next
// and previous line, kill to the end and yank it back, delete forward and back, transpose, open a line, page down,
// centre the line.
const MAC_CONTROL_LETTERS = new Set([`a`, `e`, `b`, `f`, `n`, `p`, `k`, `y`, `d`, `h`, `t`, `o`, `v`, `l`]);

/** The letter a key sits on, from its physical code (`KeyH` → `h`), whatever the layout or Option typed there. */
export const letterOfCode = (code: string | undefined): string | undefined =>
    code !== undefined && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : undefined;

/** Whether a Mac text field answers this chord itself (moving the caret, deleting, the ⌃ Emacs letters). */
export const isMacTextChord = (event: Pick<KeyboardEvent, `key` | `code` | `ctrlKey` | `metaKey` | `altKey` | `shiftKey`>): boolean => {
    const { ctrlKey, metaKey, altKey } = event;
    if (MAC_TEXT_KEYS.has(event.key) && !ctrlKey && altKey !== metaKey) {
        return true;
    }
    return ctrlKey && !metaKey && !altKey && !event.shiftKey && MAC_CONTROL_LETTERS.has(letterOfCode(event.code) ?? event.key.toLowerCase());
};

// How a named key is drawn on a Mac: the glyphs its menus use.
const MAC_GLYPHS = new Map([
    [`enter`, `↩`],
    [`backspace`, `⌫`],
    [`delete`, `⌦`],
    [`escape`, `⎋`],
    [`tab`, `⇥`],
    [`arrowleft`, `←`],
    [`arrowright`, `→`],
    [`arrowup`, `↑`],
    [`arrowdown`, `↓`],
    [`pageup`, `⇞`],
    [`pagedown`, `⇟`],
    [`home`, `↖`],
    [`end`, `↘`],
]);

/** A named key's glyph on a Mac (`enter` → ↩), or undefined for a key drawn as its own character or name. */
export const macGlyph = (key: string): string | undefined => MAC_GLYPHS.get(key.toLowerCase());

/** The key cap for a lone key in a hint: the Mac glyph, or the key's name in the reader's language elsewhere. */
export const keyCap = (key: `enter` | `escape` | `space`, isMac: boolean = isApplePlatform()): string => {
    if (key === `space`) {
        return t(`ui.keys.space`);
    }
    if (isMac) {
        return MAC_GLYPHS.get(key) ?? key;
    }
    return key === `enter` ? t(`ui.keys.enter`) : t(`ui.keys.esc`);
};

// Editors that read an input method's keystrokes themselves (CodeMirror, Monaco, xterm), which a guard must leave alone.
const OWN_COMPOSITION = `.cm-editor, .monaco-editor, .xterm`;

/**
 * Stops an Enter that confirmed an input method's candidate before any field's own handler sees it, so no field submits
 * a half-composed word (a rename, a search, a form) whether or not it checks itself: Vue's `@keydown.enter` does not.
 * In capture, on the window, for plain fields only.
 */
export const installComposingEnterGuard = (win: Window = window): void => {
    win.addEventListener(
        `keydown`,
        (event) => {
            if (event.key === `Enter` && composingKey(event) && event.target instanceof Element && event.target.closest(OWN_COMPOSITION) === null) {
                event.stopImmediatePropagation();
            }
        },
        true,
    );
};
