/* Keybinding notation and matching — the pure core the shell's dispatcher (useKeybindings) and the Command
 * Palette (QuickOpen) both build on. A binding is a chord string in VSCode-ish notation: modifier tokens plus one
 * key, joined by "+", e.g. "Mod+P", "Mod+Shift+P", "Ctrl+`". Modifiers are case-insensitive; `Mod` is the
 * cross-platform primary (⌘ on Apple, Ctrl elsewhere) so one binding string serves both platforms — the split
 * VSCode pays for with per-OS keymaps. Everything here is a pure function taking `isMac` explicitly, so it is unit-
 * testable without touching `navigator`; the shell resolves the real platform once via `isApplePlatform()`. */

interface Chord {
    readonly mod: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
    // The non-modifier key, lowercased (e.g. "p", "`", "enter").
    readonly key: string;
}

const KEY_ALIASES: Readonly<Record<string, string>> = { esc: `escape`, space: ` `, return: `enter` };

// Physical-key fallback for the number/punctuation row, whose `event.key` is unreliable: under Shift the
// Backquote key reports "~" (or "Dead" on layouts where tilde composes accents) and Digit5 reports "%", and
// the produced glyph shifts with the layout. Matching a chord's BASE character against `event.code` too — the
// VSCode approach (physical position) — makes "Ctrl+Shift+`" / "Ctrl+Shift+5" fire regardless. Scoped to this
// row on purpose: letters keep their produced-character semantics (a Dvorak user's Ctrl+P stays the P they
// typed, not the physical QWERTY position), and the reliable named keys match through `event.key` as before.
const CODE_TO_KEY: Readonly<Record<string, string>> = {
    Backquote: `\``,
    Minus: `-`,
    Equal: `=`,
    BracketLeft: `[`,
    BracketRight: `]`,
    Backslash: `\\`,
    Semicolon: `;`,
    Quote: `'`,
    Comma: `,`,
    Period: `.`,
    Slash: `/`,
    Digit0: `0`,
    Digit1: `1`,
    Digit2: `2`,
    Digit3: `3`,
    Digit4: `4`,
    Digit5: `5`,
    Digit6: `6`,
    Digit7: `7`,
    Digit8: `8`,
    Digit9: `9`,
};
const codeToKey = (code: string | undefined): string | undefined => (code === undefined ? undefined : CODE_TO_KEY[code]);

const parseChord = (binding: string): Chord => {
    const tokens = binding.split(`+`).map((token) => token.trim().toLowerCase());
    let mod = false;
    let ctrl = false;
    let meta = false;
    let shift = false;
    let alt = false;
    let key = ``;
    for (const token of tokens) {
        if (token === `mod`) {
            mod = true;
        } else if (token === `ctrl` || token === `control`) {
            ctrl = true;
        } else if (token === `meta` || token === `cmd` || token === `command`) {
            meta = true;
        } else if (token === `shift`) {
            shift = true;
        } else if (token === `alt` || token === `option`) {
            alt = true;
        } else {
            key = KEY_ALIASES[token] ?? token;
        }
    }
    return { mod, ctrl, meta, shift, alt, key };
};

// Does a live keydown satisfy this binding? Modifiers are matched EXACTLY (VSCode semantics) so "Mod+P" never
// also fires on "Mod+Shift+P". `Mod` resolves to the Command key on Apple platforms and Control elsewhere. The
// key matches on the produced character OR — for the number/punctuation row — the physical key (see
// CODE_TO_KEY), so a Shift glyph / dead key / foreign layout can't break a symbol chord like Ctrl+Shift+`.
export const matchesChord = (binding: string, event: KeyboardEvent, isMac: boolean): boolean => {
    const chord = parseChord(binding);
    const needCtrl = chord.ctrl || (chord.mod && !isMac);
    const needMeta = chord.meta || (chord.mod && isMac);
    return (
        event.ctrlKey === needCtrl &&
        event.metaKey === needMeta &&
        event.shiftKey === chord.shift &&
        event.altKey === chord.alt &&
        (event.key.toLowerCase() === chord.key || codeToKey(event.code) === chord.key)
    );
};

// Turn a live keydown into a binding string in this notation — the "record shortcut" capture the keybindings
// settings UI uses. Returns undefined for a keystroke that isn't a valid global shortcut: a lone modifier (still
// waiting for the real key), or a bare key with no modifier that isn't a function key (binding a naked letter
// globally would hijack typing). The primary modifier is recorded as `Mod` so one capture serves both platforms
// (a ⌘ on Apple / Ctrl elsewhere becomes the same portable `Mod`); a literal Control held on Apple stays `Ctrl`.
export const chordFromEvent = (event: KeyboardEvent, isMac: boolean): string | undefined => {
    if (event.key === `Control` || event.key === `Shift` || event.key === `Alt` || event.key === `Meta`) {
        return undefined;
    }
    // Record number/punctuation keys by their physical base character (codeToKey), so a Shift-recorded chord
    // stores "5"/"`" not "%"/"~" and matches back through the same physical-key path; named/letter keys keep
    // their produced character.
    const key = codeToKey(event.code) ?? (event.key === ` ` ? `space` : event.key.toLowerCase());
    const hasNonShiftModifier = event.ctrlKey || event.metaKey || event.altKey;
    if (!hasNonShiftModifier && !/^f\d+$/.test(key)) {
        return undefined;
    }
    const parts: string[] = [];
    if (isMac) {
        if (event.metaKey) {
            parts.push(`Mod`);
        }
        if (event.ctrlKey) {
            parts.push(`Ctrl`);
        }
    } else if (event.ctrlKey) {
        parts.push(`Mod`);
    }
    if (event.altKey) {
        parts.push(`Alt`);
    }
    if (event.shiftKey) {
        parts.push(`Shift`);
    }
    parts.push(key);
    return parts.join(`+`);
};

const displayKey = (key: string): string => (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));

// The human label shown in the palette: the native glyph stack on Apple (⌃⌥⇧⌘, VSCode's order, no separators),
// the spelled-and-joined form elsewhere (Ctrl+Shift+Alt+Key).
export const formatChord = (binding: string, isMac: boolean): string => {
    const chord = parseChord(binding);
    const ctrl = chord.ctrl;
    const meta = chord.meta || chord.mod;
    if (isMac) {
        const parts = [ctrl ? `⌃` : ``, chord.alt ? `⌥` : ``, chord.shift ? `⇧` : ``, meta ? `⌘` : ``, displayKey(chord.key)];
        return parts.join(``);
    }
    // Non-Apple: `Mod` and any literal `meta` both read as Ctrl.
    const parts = [ctrl || meta ? `Ctrl` : ``, chord.shift ? `Shift` : ``, chord.alt ? `Alt` : ``, displayKey(chord.key)].filter(Boolean);
    return parts.join(`+`);
};

// The one impure helper: read the running platform. Kept apart from the pure matchers above so tests pass `isMac`
// explicitly and never depend on the host.
export const isApplePlatform = (): boolean => /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
