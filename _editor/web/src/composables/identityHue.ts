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

/* A PERSONA'S COLOUR — the same idea, off the WHOLE wheel rather than eight fixed stops.
 *
 * Eight is right for members: a workspace has a handful, they are labelled by name everywhere they appear, and
 * the hue also has to survive being used as a pale tinted mark. A persona list is the opposite case on both
 * counts. It is scanned by FACE — the mark is the biggest thing in the row and the point of it is to find
 * somebody without reading — and the colour is only ever a solid fill behind white initials, which is legible
 * at any hue (Avatar pins saturation and lightness). Against eight stops the collisions were immediate rather
 * than theoretical: `shop-support`, `maintainer` and `personal` all land on the same blue, so a rail of three
 * personas drew two identical faces.
 *
 * FNV-1a rather than the ×31 above, because that one's low bits barely move between short similar strings —
 * which is exactly what persona ids are — and taking a modulus keeps only the low bits. FNV mixes into all 32.
 *
 * SEEDED BY ID, while the initials come from the name: renaming somebody changes what their face says and not
 * what colour it is, so a face you have learned to spot survives being relabelled. */
export const personaHue = (seed: string): number => {
    let hash = 0x81_1c_9d_c5;
    for (const char of seed) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 0x01_00_01_93) >>> 0;
    }
    return hash % 360;
};
