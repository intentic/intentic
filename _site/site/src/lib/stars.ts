// The repository's star count as the GitHub mark wears it: short enough to sit beside an 18px glyph, and never more
// than the real figure, so thousands are cut down rather than rounded up (1,999 reads 1.9k, not 2k).

const UNITS: ReadonlyArray<readonly [number, string]> = [
    [1_000_000, "M"],
    [1_000, "k"],
];

/** `99`, `1.2k`, `12k`, `340k`, `1.2M`: one decimal below ten of a unit, none above. */
export function formatStars(stars: number): string {
    for (const [size, unit] of UNITS) {
        if (stars >= size) {
            const scaled = stars / size;
            const shown = scaled < 10 ? Math.floor(scaled * 10) / 10 : Math.floor(scaled);
            return `${String(shown)}${unit}`;
        }
    }
    return String(stars);
}

/** The exact figure in words, for the link's accessible name and its tooltip. */
export function starsPhrase(stars: number): string {
    return `${stars.toLocaleString("en-US")} ${stars === 1 ? "star" : "stars"}`;
}
