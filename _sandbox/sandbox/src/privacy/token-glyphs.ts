// The lettering a masked image's tokens are drawn in: a 5x7 pixel font for exactly the characters a token can hold
// (⟦, ⟧, A-Z, 0-9, _), carried here rather than asked of the system's fonts so a token looks the same on every
// sandbox and the same image always masks to the same bytes, which is what keeps a provider's prompt cache.

const GLYPH_ROWS: Readonly<Record<string, string>> = {
    A: ".###. #...# #...# ##### #...# #...# #...#",
    B: "####. #...# #...# ####. #...# #...# ####.",
    C: ".###. #...# #.... #.... #.... #...# .###.",
    D: "####. #...# #...# #...# #...# #...# ####.",
    E: "##### #.... #.... ####. #.... #.... #####",
    F: "##### #.... #.... ####. #.... #.... #....",
    G: ".###. #...# #.... #.### #...# #...# .####",
    H: "#...# #...# #...# ##### #...# #...# #...#",
    I: ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
    J: "..### ...#. ...#. ...#. ...#. #..#. .##..",
    K: "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
    L: "#.... #.... #.... #.... #.... #.... #####",
    M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
    N: "#...# #...# ##..# #.#.# #..## #...# #...#",
    O: ".###. #...# #...# #...# #...# #...# .###.",
    P: "####. #...# #...# ####. #.... #.... #....",
    Q: ".###. #...# #...# #...# #.#.# #..#. .##.#",
    R: "####. #...# #...# ####. #.#.. #..#. #...#",
    S: ".#### #.... #.... .###. ....# ....# ####.",
    T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
    U: "#...# #...# #...# #...# #...# #...# .###.",
    V: "#...# #...# #...# #...# #...# .#.#. ..#..",
    W: "#...# #...# #...# #.#.# #.#.# #.#.# .#.#.",
    X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
    Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
    Z: "##### ....# ...#. ..#.. .#... #.... #####",
    "0": ".###. #...# #..## #.#.# ##..# #...# .###.",
    "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
    "2": ".###. #...# ....# ...#. ..#.. .#... #####",
    "3": "##### ...#. ..#.. ...#. ....# #...# .###.",
    "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
    "5": "##### #.... ####. ....# ....# #...# .###.",
    "6": "..##. .#... #.... ####. #...# #...# .###.",
    "7": "##### ....# ...#. ..#.. .#... .#... .#...",
    "8": ".###. #...# #...# .###. #...# #...# .###.",
    "9": ".###. #...# #...# .#### ....# ...#. .##..",
    _: "..... ..... ..... ..... ..... ..... #####",
    "⟦": "####. #.#.. #.#.. #.#.. #.#.. #.#.. ####.",
    "⟧": ".#### ..#.# ..#.# ..#.# ..#.# ..#.# .####",
    "[": ".###. .#... .#... .#... .#... .#... .###.",
    "]": ".###. ...#. ...#. ...#. ...#. ...#. .###.",
    " ": "..... ..... ..... ..... ..... ..... .....",
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
// One empty column between letters.
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

// Each glyph as rows of booleans; an unknown character draws as a blank.
const GLYPHS: ReadonlyMap<string, readonly (readonly boolean[])[]> = new Map(
    Object.entries(GLYPH_ROWS).map(([char, rows]) => [char, rows.split(" ").map((row) => [...row].map((cell) => cell === "#"))]),
);

// Whether font unit (column, row) of `text` is ink.
const inked = (chars: readonly string[], column: number, row: number): boolean => {
    if (row < 0 || row >= GLYPH_HEIGHT || column < 0) {
        return false;
    }
    const glyph = GLYPHS.get(chars[Math.floor(column / GLYPH_ADVANCE)] ?? " ");
    return glyph?.[row]?.[column % GLYPH_ADVANCE] ?? false;
};

// How wide `text` is in font units.
export const textUnits = (text: string): number => Math.max(0, [...text].length * GLYPH_ADVANCE - 1);

// Samples per pixel side: four by four inside each pixel, so a fractional unit still draws smooth strokes.
const SAMPLES = 4;

interface Lettering {
    readonly chars: readonly string[];
    // The text's width in font units.
    readonly units: number;
    readonly origin: { readonly x: number; readonly y: number };
    readonly unit: number;
}

// How much of pixel (px, py) the lettering inks, 0 to 1.
const pixelCoverage = ({ chars, units, origin, unit }: Lettering, px: number, py: number): number => {
    let hits = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
        const row = Math.floor((py + (sy + 0.5) / SAMPLES - origin.y) / unit);
        for (let sx = 0; sx < SAMPLES; sx += 1) {
            const column = Math.floor((px + (sx + 0.5) / SAMPLES - origin.x) / unit);
            hits += column < units && inked(chars, column, row) ? 1 : 0;
        }
    }
    return hits / (SAMPLES * SAMPLES);
};

// The ink coverage (0 to 1) of every pixel of `text` drawn with its top-left at (x, y), `unit` pixels per font unit.
export const textCoverage = (
    text: string,
    origin: { readonly x: number; readonly y: number },
    unit: number,
    visit: (x: number, y: number, coverage: number) => void,
): void => {
    const lettering: Lettering = { chars: [...text], units: textUnits(text), origin, unit };
    const width = lettering.units * unit;
    const height = GLYPH_HEIGHT * unit;
    for (let py = Math.floor(origin.y); py < Math.ceil(origin.y + height); py += 1) {
        for (let px = Math.floor(origin.x); px < Math.ceil(origin.x + width); px += 1) {
            const coverage = pixelCoverage(lettering, px, py);
            if (coverage > 0) {
                visit(px, py, coverage);
            }
        }
    }
};
