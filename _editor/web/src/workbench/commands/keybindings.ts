// Keybinding notation and matching, shared by useKeybindings and the Command Palette. A binding is a chord string in
// VSCode notation (modifiers + one key joined by "+", case-insensitive); `Mod` is Cmd on Apple, Ctrl elsewhere.
// Functions take `isMac` explicitly rather than reading `navigator`.

interface Chord {
    readonly mod: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
    // Non-modifier key, lowercased (e.g. "p", "`", "enter").
    readonly key: string;
}

const KEY_ALIASES: Readonly<Record<string, string>> = { esc: `escape`, space: ` `, return: `enter` };

// Physical-key fallback for the number/punctuation row, since event.key varies with Shift and layout there.
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

// Modifiers must match exactly (VSCode semantics); `Mod` is Cmd on Apple, Ctrl elsewhere. Key matches by produced
// character or, on the number/punctuation row, by physical code (CODE_TO_KEY).
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

// Converts a live keydown into this notation's binding string, for the keybindings settings' "record shortcut"
// capture. Returns undefined for a lone modifier or an unmodified non-function key; the primary modifier is recorded as
// `Mod`.
export const chordFromEvent = (event: KeyboardEvent, isMac: boolean): string | undefined => {
    if (event.key === `Control` || event.key === `Shift` || event.key === `Alt` || event.key === `Meta`) {
        return undefined;
    }
    // Number/punctuation keys record by physical code, so a Shift-recorded chord stores "5"/"`" not "%"/"~".
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

// Named keys whose display label isn't just capitalized (arrows use their glyph, e.g. "↑").
const DISPLAY_NAMES: Readonly<Record<string, string>> = { pageup: `PageUp`, pagedown: `PageDown`, arrowup: `↑`, arrowdown: `↓` };

const displayKey = (key: string): string => DISPLAY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));

// Human-readable label for a binding: the native glyph stack (⌃⌥⇧⌘) in VSCode's order on Apple, the spelled-and-joined
// form (Ctrl+Shift+Alt+Key) elsewhere.
export const formatChord = (binding: string, isMac: boolean): string => {
    const chord = parseChord(binding);
    const ctrl = chord.ctrl;
    const meta = chord.meta || chord.mod;
    if (isMac) {
        const parts = [ctrl ? `⌃` : ``, chord.alt ? `⌥` : ``, chord.shift ? `⇧` : ``, meta ? `⌘` : ``, displayKey(chord.key)];
        return parts.join(``);
    }
    // Non-Apple: `Mod` and a literal `meta` both display as Ctrl.
    const parts = [ctrl || meta ? `Ctrl` : ``, chord.shift ? `Shift` : ``, chord.alt ? `Alt` : ``, displayKey(chord.key)].filter(Boolean);
    return parts.join(`+`);
};

// Reads the running platform; kept separate so the matchers above take `isMac` explicitly and stay testable
// without a host.
export const isApplePlatform = (): boolean => /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
