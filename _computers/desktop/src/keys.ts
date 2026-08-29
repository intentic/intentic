import { DesktopError } from "./types.js";

/* ONE key vocabulary, rendered per backend.
 *
 * The alternative, letting callers pass whatever their platform's tool wants, makes every caller
 * platform-aware, which is the exact coupling this package exists to remove: a model that learned `ctrl+c` on
 * Linux would have to learn `^c` for Windows, and the first thing it would do on an unfamiliar machine is guess.
 * So the vocabulary is fixed here and the backends translate.
 *
 * It is X11's names, because they are the ones already written down in a thousand places and the ones a model
 * has most likely seen: `Return`, `Escape`, `BackSpace`, `Page_Up`, `ctrl+shift+t`. Common aliases are accepted
 * (Enter, Esc, Backspace, PageUp, cmd, win) so a caller reaching for the obvious word is not punished. */

export type Modifier = "ctrl" | "alt" | "shift" | "super";

export interface Chord {
    readonly modifiers: readonly Modifier[];
    // The non-modifier key, in this package's canonical spelling (X11 keysym names, or a single character).
    readonly key: string;
}

const MODIFIERS: Record<string, Modifier> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    opt: "alt",
    shift: "shift",
    super: "super",
    win: "super",
    windows: "super",
    cmd: "super",
    command: "super",
    meta: "super",
};

// Canonical spellings for the keys with more than one obvious name. Everything else (letters, digits,
// punctuation, F-keys) passes through as typed, which is what both backends want.
const ALIASES: Record<string, string> = {
    enter: "Return",
    return: "Return",
    esc: "Escape",
    escape: "Escape",
    backspace: "BackSpace",
    del: "Delete",
    delete: "Delete",
    ins: "Insert",
    insert: "Insert",
    space: "space",
    spacebar: "space",
    tab: "Tab",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    home: "Home",
    end: "End",
    pageup: "Page_Up",
    page_up: "Page_Up",
    pgup: "Page_Up",
    pagedown: "Page_Down",
    page_down: "Page_Down",
    pgdn: "Page_Down",
};

/* Split on "+", except when "+" IS the key: "ctrl++" is zoom-in in most applications, and a naive split reads its
 * key as empty. That case is spelled `<modifiers>++`, so it shows up as an empty LAST segment with a real one
 * before it, three parts for one modifier. A trailing separator with nothing to its left ("ctrl+") is not that;
 * it is a chord missing its key, and falls through to the error that says so. */
const segments = (combo: string): string[] => {
    if (combo === "+") {
        return ["+"];
    }
    const parts = combo.split("+");
    if (parts.length >= 3 && parts.at(-1) === "" && parts.at(-2) === "") {
        return [...parts.slice(0, -2), "+"];
    }
    return parts;
};

export const parseChord = (combo: string): Chord => {
    const trimmed = combo.trim();
    if (trimmed === "") {
        throw new DesktopError("No key given.");
    }
    const parts = segments(trimmed);
    const key = parts.at(-1) ?? "";
    const modifiers: Modifier[] = [];
    for (const part of parts.slice(0, -1)) {
        const modifier = MODIFIERS[part.trim().toLowerCase()];
        if (modifier === undefined) {
            throw new DesktopError(`"${part}" is not a modifier. Use ctrl, alt, shift or super (win/cmd).`);
        }
        if (!modifiers.includes(modifier)) {
            modifiers.push(modifier);
        }
    }
    if (key === "") {
        throw new DesktopError(`"${combo}" has modifiers but no key.`);
    }
    // A single character keeps its case (shift is a modifier, not capitalisation); a named key is canonicalised.
    const canonical = key.length === 1 ? key : (ALIASES[key.toLowerCase()] ?? key);
    return { modifiers, key: canonical };
};

// xdotool speaks this vocabulary natively, it IS X11 keysyms, so rendering is joining it back up.
export const xdotoolChord = (combo: string): string => {
    const chord = parseChord(combo);
    return [...chord.modifiers.map((modifier) => (modifier === "super" ? "super" : modifier)), chord.key].join("+");
};

// wtype's modifier flags are the same words; its key names are keysyms too, so only the shape differs.
export const wtypeArgs = (combo: string): string[] => {
    const chord = parseChord(combo);
    return [...chord.modifiers.flatMap((modifier) => ["-M", modifier === "super" ? "logo" : modifier]), "-k", chord.key];
};

/* Windows virtual-key codes. The reason keys do NOT go through SendKeys on Windows, though text does: SendKeys
 * has no way to press the Windows key at all, so `super+e`, open Explorer, one of the most useful chords there
 * is, would be silently undeliverable. keybd_event with explicit VK codes can express every chord. */
const VK: Record<string, number> = {
    ctrl: 0x11,
    alt: 0x12,
    shift: 0x10,
    super: 0x5b,
    Return: 0x0d,
    Tab: 0x09,
    Escape: 0x1b,
    BackSpace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    space: 0x20,
    Left: 0x25,
    Up: 0x26,
    Right: 0x27,
    Down: 0x28,
    Home: 0x24,
    End: 0x23,
    Page_Up: 0x21,
    Page_Down: 0x22,
};

export interface WindowsChord {
    readonly modifiers: readonly number[];
    readonly key: number;
}

export const windowsChord = (combo: string): WindowsChord => {
    const chord = parseChord(combo);
    const modifiers = chord.modifiers.map((modifier) => VK[modifier] ?? 0);
    const named = VK[chord.key];
    if (named !== undefined) {
        return { modifiers, key: named };
    }
    // F1–F24 are contiguous from 0x70, letters and digits map to their ASCII code, the two families that would
    // otherwise need forty table entries each.
    const fkey = /^[fF](\d{1,2})$/.exec(chord.key);
    if (fkey?.[1] !== undefined) {
        const index = Number(fkey[1]);
        if (index >= 1 && index <= 24) {
            return { modifiers, key: 0x6f + index };
        }
    }
    if (chord.key.length === 1) {
        const code = chord.key.toUpperCase().charCodeAt(0);
        if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) {
            return { modifiers, key: code };
        }
    }
    throw new DesktopError(
        `This computer cannot press "${chord.key}": name it as a letter, a digit, F1–F24, or a key like Return, Tab, Escape, Page_Up.`,
    );
};
