// Deterministic identity accent — the seed (a member's email) hashes into one of 8 fixed hues, so the same
// person keeps their colour on every surface, across sessions and browsers, with no assignment state. The
// palette is curated rather than a free hue wheel: every entry stays legible as Avatar's fill and as a tinted
// mark in both color schemes. (Session cards used to hash into this too; they wear sessionCategory now — colour
// as meaning — while a person's colour stays pure identity, because a person is not a kind of work.)
const HUES = [210, 350, 160, 40, 280, 20, 130, 320];
export const identityHue = (seed: string): number => {
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return HUES[Math.abs(hash) % HUES.length]!;
};
