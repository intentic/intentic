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

/**
 * Whether a keystroke is Ctrl+Enter or ⌘+Enter, the chord that sends what a field holds: a one-line field's Enter, and
 * the only way a multi-line field has. Either modifier on either platform, as the chat composer reads it, since ⌃↩ is no
 * text chord on a Mac; Shift or Alt with it is some other chord.
 */
export const isModEnter = (event: Pick<KeyboardEvent, `key` | `ctrlKey` | `metaKey` | `shiftKey` | `altKey`>): boolean =>
    event.key === `Enter` && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;

/**
 * Whether a keydown is the send chord for the surface whose listener it reached (`currentTarget`): Ctrl+Enter or ⌘+Enter,
 * not claimed below it, not an input method's, and not from a field in a form inside that surface, whose own submit it
 * is (installModEnterSubmit). For a panel, a dialog or an editor that has one Save for many fields and no form of its own.
 */
export const isSendKey = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || !isModEnter(event) || composingKey(event)) {
        return false;
    }
    const form = event.target instanceof Element ? event.target.closest(`form`) : null;
    const surface = event.currentTarget;
    return form === null || !(surface instanceof Node) || !surface.contains(form);
};

// Inputs that press rather than hold text: Enter on one already does what it says.
const PRESSED_INPUTS = new Set([`submit`, `button`, `reset`, `image`, `file`]);

// The form a keystroke's field belongs to. `instanceof` holds in a window the app popped out as well: Vue creates every
// element it mounts there from this window's document.
const formOfField = (target: EventTarget | null): HTMLFormElement | undefined => {
    const field =
        target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !PRESSED_INPUTS.has(target.type))
            ? target
            : undefined;
    if (field === undefined || field.closest(OWN_COMPOSITION) !== null) {
        return undefined;
    }
    return field.form ?? undefined;
};

// The button Enter would press: the form's first submit button, in tree order, including one outside it that names it.
const defaultButton = (form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | undefined =>
    [...form.elements].find(
        (element): element is HTMLButtonElement | HTMLInputElement =>
            (element instanceof HTMLButtonElement && element.type === `submit`) ||
            (element instanceof HTMLInputElement && (element.type === `submit` || element.type === `image`)),
    );

/**
 * Ctrl+Enter (⌘+Enter) in a field of a form submits the form, as Enter does in a one-line field: a browser submits on a
 * bare Enter only, and never from a textarea. It goes through the form's default button, so a disabled one holds it as
 * it holds Enter, and through `requestSubmit`, so the browser's own validation still speaks first. On the window and
 * bubbling, so a field that answers the chord itself (the chat composer) and says so with `preventDefault` keeps it.
 * Answers what takes it off again.
 */
export const installModEnterSubmit = (win: Window = window): (() => void) => {
    const submit = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || !isModEnter(event) || composingKey(event)) {
            return;
        }
        const form = formOfField(event.target);
        if (form === undefined) {
            return;
        }
        const button = defaultButton(form);
        if (button?.matches(`:disabled`)) {
            return;
        }
        event.preventDefault();
        form.requestSubmit(button);
    };
    win.addEventListener(`keydown`, submit);
    return () => win.removeEventListener(`keydown`, submit);
};
