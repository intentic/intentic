import type { ITheme } from "@xterm/xterm";

// xterm paints its own glyphs on its own canvas, so none of a terminal's colours arrive through CSS inheritance: the
// whole palette is handed over as literal values. The app owns ONE of them, `--color-terminal` (a hex literal, because
// xterm's parser rejects oklch() and color-mix()); the ink and the sixteen ANSI slots are decided here, from how light
// that ground is. Reading the ground rather than the scheme is what lets a skin keep a dark terminal inside a light
// scheme, and the reverse, without this file knowing any skin's name.

const FALLBACK = `#0a0a0a`;

/** Perceived lightness of a `#rgb[a]`/`#rrggbb[aa]` colour, 0–1; anything above 0.5 is paper. */
const lightness = (hex: string): number => {
    const body = hex.replace(`#`, ``);
    const wide = body.length >= 6;
    const channel = (at: number): number => {
        const raw = wide ? body.slice(at * 2, at * 2 + 2) : body.slice(at, at + 1).repeat(2);
        return Number.parseInt(raw, 16) / 255;
    };
    const [r, g, b] = [channel(0), channel(1), channel(2)];
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
        return 0;
    }
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// The palette for a terminal drawn on paper. xterm's own defaults are the Tango set, chosen for a near-black ground:
// on a light one its bright green and bright yellow carry about 1.3:1 and are simply not there. Every normal slot here
// clears 4.5:1 on the light ground, and the BRIGHT slots are deeper than a dark scheme's rather than paler — "bright"
// means "stands out from the page", which on paper is the opposite direction. Neutrals are warmed to the light
// scheme's own paper; the chromatic slots are GitHub Light's, which are measured and widely recognised.
const PAPER: ITheme = {
    foreground: `#302b26`,
    cursor: `#302b26`,
    // Kept translucent: a selection lies over all sixteen colours, and an opaque plate would hide the one under it.
    selectionBackground: `#0969da2e`,
    black: `#3a342e`,
    red: `#cf222e`,
    green: `#116329`,
    // Yellow is the slot a dark palette can afford to make luminous and a light one cannot; this is amber, not yellow.
    yellow: `#7d4e00`,
    blue: `#0969da`,
    magenta: `#8250df`,
    cyan: `#1b7c83`,
    // Slot 7 is a near-white on a dark ground and would print as nothing here; a mid grey is what light themes put in
    // it, since programs reach for it as ordinary text.
    white: `#6f6760`,
    brightBlack: `#857c74`,
    brightRed: `#a40e26`,
    brightGreen: `#1a7f37`,
    brightYellow: `#9a6700`,
    brightBlue: `#1f6feb`,
    brightMagenta: `#9250e8`,
    brightCyan: `#2d8f9b`,
    brightWhite: `#9c938b`,
};

/** What xterm needs to paint one session: the palette, and the contrast floor that catches what it can't cover. */
export interface TerminalPaint {
    readonly theme: ITheme;
    readonly minimumContrastRatio: number;
}

// A floor xterm applies per glyph, lightening or darkening ink until it clears this against the ground behind it. The
// sixteen slots above are already over it; this is for the ~240 EXTENDED ones, which a palette cannot restate — a
// program that prints in 256-colour or true colour picked its shade for a black terminal, and half that cube is
// invisible on paper. 4.5 is AA for body text, which is what a terminal is. Dark keeps 1 (xterm's default, off), so
// the near-black scheme renders exactly as it always has.
const PAPER_MIN_CONTRAST = 4.5;
const INK_AS_AUTHORED = 1;

/** How to paint a terminal on whatever `--color-terminal` currently resolves to on `<html>`. */
export const terminalPaint = (): TerminalPaint => {
    const background = getComputedStyle(document.documentElement).getPropertyValue(`--color-terminal`).trim() || FALLBACK;
    // A dark ground takes the background alone: xterm's defaults were built for it, and they stay the dark palette.
    // `cursorAccent` is the glyph UNDER a block cursor, so it takes the ground itself rather than a second copy of it.
    return lightness(background) > 0.5
        ? { theme: { ...PAPER, background, cursorAccent: background }, minimumContrastRatio: PAPER_MIN_CONTRAST }
        : { theme: { background }, minimumContrastRatio: INK_AS_AUTHORED };
};
