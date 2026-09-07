/* THE MARK, AS AN ICON: the one place the three icon ladders agree.
 *
 * `src/components/ornaments.ts` holds the DRAWING — the lotus the bar, every bullet and every frame finial
 * render from. What is here is the second half of the answer, the part that turns that drawing into a square
 * icon: which paths survive the crop, what box they are drawn on, and the one ember they are filled with.
 *
 * Three ladders ask for it — this package's favicons (`scripts/icons.mjs`), the Tauri bundle's OS icons
 * (`_editor/desktop-app/scripts/icons.mjs`) and the browser extension's store PNGs
 * (`_devices/webext/scripts/render-icons.mjs`) — and until this file existed all three carried their own copy
 * of the extraction, the leaf filter, the assertion, the crop and the colour. The webext script named the cost
 * in a comment: "three copies of two constants is the price of not making the DRAWING three copies." It is not
 * a price that has to be paid: the geometry is one decision, so it is written once and imported by relative
 * path, which is how the icon ladders already reach the ornament kit.
 *
 * WHY THERE IS NO PLATE, AND ONLY FIVE PETALS. The mark shipped on the site's own warm ground with a glow
 * behind it, on the theory that ember needs a guaranteed backdrop. At 16px that reasoning inverted: the plate
 * ate four fifths of the square, the flower was left at 68% of what was left, and a browser tab showed a dark
 * chip with an orange smudge in it — the mark was the smallest thing in its own icon.
 *
 * So the ground goes and the drawing grows into the whole square. The two leaves go with it: they are drawn at
 * .42 opacity, which is a tonal step the eye reads at 32px and mud at 16, and they are the widest part of the
 * silhouette, so carrying them cost the PETALS about a fifth of their size for a shape nobody could resolve.
 * Five petals fill the box, and the outline that is left is unmistakably this flower.
 *
 * Transparent is also the honest answer to a surface that is white on most machines and near-black on the rest
 * — a tab strip, a toolbar, a taskbar. Ember holds its own on both, where a fixed ground can only match one. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The ornament kit, from any of the three ladders: this file sits two directories under the repository root. */
export const ORNAMENTS = join(import.meta.dirname, "../src/components/ornaments.ts");

/** The one ember the brand spends, from global.css. Named here rather than imported: a stylesheet is not a module. */
export const EMBER = "#e07b27";

/* THE PETALS FILL THE SQUARE. With the leaves gone the drawing is narrower than it is tall, so the box is
 * cropped to what is left rather than being padded around the old silhouette: it keeps the kit's own vertical
 * extents (the petals run y≈3.4 to 22) and takes only the width the petals actually span (x≈11.8 to 20.2 at the
 * waist, 8 to 24 at the widest). A hair of margin, and no more: this is 16px, and every unit spent on air is a
 * unit off the only shape in it. */
export const PETALS_BOX = "7.2 2.6 17.6 20.2";

/* The five petals, lifted out of the ornament kit rather than pasted. The kit exports the lotus as a template
 * literal holding a whole <svg>; what is wanted is the paths inside it.
 *
 * The two leaves are dropped by the only thing that identifies them without this file holding its own copy of
 * the drawing: they are the paths the kit draws at .42. If the lotus is ever redrawn at different opacities
 * this stops matching and THROWS, rather than silently drawing a different flower. */
export const petals = () => {
    const kit = readFileSync(ORNAMENTS, "utf8");
    const lotus = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
    if (lotus === undefined) {
        throw new Error(`No LOTUS export found in ${ORNAMENTS}: the mark moved, and every icon ladder has to follow it.`);
    }
    const all = lotus.match(/<path\b[^>]*\/>/gu) ?? [];
    const kept = all.filter((path) => !path.includes('opacity=".42"'));
    if (kept.length !== all.length - 2) {
        throw new Error(`Expected two .42-opacity leaves in LOTUS, found ${all.length - kept.length}`);
    }
    return kept;
};

/** One square icon at `size`, on the crop above, in the one ember. An EXPLICIT square viewport is the important
 *  half: a rasteriser told only a width preserves the crop's portrait ratio and writes 16x18 under a square name. */
export const icon = (size, paths) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${PETALS_BOX}" fill="${EMBER}">\n  ${paths.join("\n  ")}\n</svg>`;

/* ICO is a directory of images bolted to a header. Every entry is 16 bytes: the size byte is 0 for 256, which
 * is the format's way of fitting 256 into eight bits, and the payloads are ordinary PNGs, which every browser
 * still in use reads. Both the favicon ladder and the Tauri one write one, at different size sets. */
export const buildIco = (images) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    let offset = 6 + images.length * 16;
    const entries = images.map(({ size, data }) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += data.length;
        return entry;
    });

    return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
};
