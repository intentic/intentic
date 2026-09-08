import { DesktopError } from "./types.js";

// One key vocabulary here; backends translate it. Uses X11 keysym names (Return, Escape, BackSpace...) with
// common aliases accepted (Enter, Esc, Backspace, PageUp, cmd, win).

export type Modifier = "ctrl" | "alt" | "shift" | "super";

export interface Chord {
    readonly modifiers: readonly Modifier[];
    // Canonical spelling: X11 keysym names, or a single character.
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

// Canonical spellings for keys with more than one common name; everything else passes through unchanged.
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

// Splits on "+"; "ctrl++" is read as key "+" (three parts, last two empty), not a missing key. "ctrl+" alone is
// missing its key and errors.
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
    // A single character keeps its case; a named key is canonicalised via ALIASES.
    const canonical = key.length === 1 ? key : (ALIASES[key.toLowerCase()] ?? key);
    return { modifiers, key: canonical };
};

// xdotool's vocabulary is X11 keysyms natively; this just rejoins the chord.
export const xdotoolChord = (combo: string): string => {
    const chord = parseChord(combo);
    return [...chord.modifiers.map((modifier) => (modifier === "super" ? "super" : modifier)), chord.key].join("+");
};

// wtype takes the same modifier words and keysym names, just shaped as flags.
export const wtypeArgs = (combo: string): string[] => {
    const chord = parseChord(combo);
    return [...chord.modifiers.flatMap((modifier) => ["-M", modifier === "super" ? "logo" : modifier]), "-k", chord.key];
};

// SendKeys cannot press the Windows key, so key chords use keybd_event with VK codes instead of SendKeys.
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
    // F1-F24 are contiguous from 0x70; letters and digits map to their ASCII code.
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
        `This device cannot press "${chord.key}": name it as a letter, a digit, F1–F24, or a key like Return, Tab, Escape, Page_Up.`,
    );
};
