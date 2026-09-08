// Shared geometry for the three icon ladders (favicons, desktop OS icons, the browser extension): crop, square box and
// ember colour applied to the lotus in `src/components/ornaments.ts`. No ground, no leaves: at 16px a filled backdrop
// drowned the flower and the leaves turned to mud, so five petals fill a transparent square.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The ornament kit, from any of the three ladders: this file sits two directories under the repository root. */
export const ORNAMENTS = join(import.meta.dirname, "../src/components/ornaments.ts");

/** The one ember the brand spends, from global.css; named here since a stylesheet is not a module. */
export const EMBER = "#e07b27";

// Box crops to the petals' actual extent, no padding: every unit of margin is a unit off the shape at 16px.
export const PETALS_BOX = "7.2 2.6 17.6 20.2";

// Extracts the lotus's paths from ornaments.ts and drops the two leaves, identified by their .42 opacity. Throws if
// that stops matching, rather than silently drawing the wrong flower.
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

/**
 * One square icon at `size`. The explicit square viewBox matters: a rasteriser given only a width keeps the crop's
 * portrait ratio, writing e.g. 16x18 under a square name.
 */
export const icon = (size, paths) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${PETALS_BOX}" fill="${EMBER}">\n  ${paths.join("\n  ")}\n</svg>`;

// ICO is a directory of images bolted to a header; each entry is 16 bytes, with the size byte 0 meaning 256. Payloads
// are ordinary PNGs.
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
