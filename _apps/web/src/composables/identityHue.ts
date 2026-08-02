// Deterministic identity accent — the seed (a member's email, a conversation's id) hashes into one of 8
// fixed hues, so the same entity keeps its colour on every surface, across sessions and browsers, with no
// assignment state. The palette is curated rather than a free hue wheel: every entry stays legible as
// Avatar's fill and as a tinted mark in both color schemes.
const HUES = [210, 350, 160, 40, 280, 20, 130, 320];
export const identityHue = (seed: string): number => {
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return HUES[Math.abs(hash) % HUES.length]!;
};

// The identity FILL — Avatar's own formula over the hash, for the surfaces that paint a tile themselves (a
// chat's identity tile on the rail card and the board card) rather than passing `hue` to Avatar. One formula,
// so a chat's colour and a member's colour read as one system.
export const identityFill = (seed: string): string => `hsl(${identityHue(seed)} 55% 42%)`;
