// Deterministic identity accents: a seed hashes into one of a few fixed hues, so the same thing keeps its colour on
// every surface, across sessions and browsers, with no assignment state. The palettes are curated rather than a free
// hue wheel: every entry stays legible as a fill and as a tinted mark in both color schemes.
const hueOf = (seed: string, hues: readonly number[]): number => {
    let hash = 0;
    // Folded, since an address is a seed and the same person reaches this with either casing.
    for (const char of seed.toLowerCase()) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return hues[Math.abs(hash) % hues.length]!;
};

// A person's colour, seeded by their email: pure identity, the whole wheel.
const PERSON_HUES = [210, 350, 160, 40, 280, 20, 130, 320];
export const identityHue = (seed: string): number => hueOf(seed, PERSON_HUES);

// A package's colour, seeded by its name: what a session card's tile and topic are tinted by (sessionKind.ts). Never red,
// orange, amber or green, since a card already says its standing in those (the rim, the corner's pill) and a package
// that drew one would read as a verdict on the work; what is left is spread at least 30° apart, because two blues a
// few degrees apart read as one package at the size of a tile.
const MODULE_HUES = [85, 175, 205, 240, 275, 310];
export const moduleHue = (name: string): number => hueOf(name, MODULE_HUES);
