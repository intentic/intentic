/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FAVICON LADDER: every icon the site hands a browser, drawn from the mark in the top-left corner.
 *
 * Run: `node scripts/icons.mjs`  (from _site/site). Its output is committed.
 *
 * ONE DRAWING, NOT A SECOND LOGO. The lotus here is not redrawn: it is read out of
 * `src/components/ornaments.ts`, the same string the bar, every bullet and every frame finial render
 * from. A favicon that is a hand-copy of the logo is a logo that will one day be two logos.
 *
 * WHY THERE IS NO PLATE, AND ONLY FIVE PETALS. The mark shipped on the site's own warm ground with a glow
 * behind it, on the theory that ember needs a guaranteed backdrop. At 16px that reasoning inverted: the
 * plate ate four fifths of the square, the flower was left at 68% of what was left, and a browser tab
 * showed a dark chip with an orange smudge in it: the mark was the smallest thing in its own icon.
 *
 * So the ground goes and the drawing grows into the whole square. The two leaves go with it: they are
 * drawn at .42 opacity, which is a tonal step the eye reads at 32px and mud at 16, and they are the widest
 * part of the silhouette: carrying them cost the PETALS about a fifth of their size for a shape nobody
 * could resolve. Five petals fill the box, and the outline that is left is unmistakably this flower.
 *
 * Transparent is also the honest answer to a tab strip that is white on most machines and near-black on
 * the rest: ember holds its own on both, where a fixed ground can only ever match one of them.
 *
 * WHY THE SVG IS NOT ENOUGH. Modern browsers prefer `favicon.svg`, but the crawlers and feed readers
 * that fetch `/favicon.ico` by convention do not read the tag that offers it, and iOS wants a real PNG.
 * So all three ship, and this script is the one place their geometry is decided.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const ORNAMENTS = join(here, "../src/components/ornaments.ts");
const PUBLIC = join(here, "../public");

/* The one ember the brand spends, from global.css. Named here rather than imported because a stylesheet is
 * not a module. */
const EMBER = "#e07b27";

/* The lotus, lifted out of the ornament kit rather than pasted. The kit exports it as a template
 * literal holding a whole <svg>; what is wanted is the paths inside it and the viewBox it is drawn on. */
const kit = await readFile(ORNAMENTS, "utf8");
const lotusSvg = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
if (!lotusSvg) throw new Error(`No LOTUS export found in ${ORNAMENTS}`);
const viewBox = /viewBox="([^"]+)"/u.exec(lotusSvg)?.[1];
if (!viewBox) throw new Error("The LOTUS drawing has no viewBox to scale from");
const allPaths = lotusSvg.match(/<path\b[^>]*\/>/gu) ?? [];
/* The two leaves, dropped: they are the only paths the kit draws at .42, which is what makes them
 * identifiable here without the icon holding its own copy of the drawing. If the lotus is ever redrawn at
 * different opacities, this stops matching and the icon gets the whole flower again: visibly wrong at a
 * glance, which is the failure mode to want. */
const petals = allPaths.filter((path) => !path.includes('opacity=".42"'));
if (petals.length !== allPaths.length - 2) {
    throw new Error(`Expected two .42-opacity leaves in LOTUS, found ${allPaths.length - petals.length}`);
}

/* THE PETALS FILL THE SQUARE. With the leaves gone the drawing is narrower than it is tall, so the box is
 * cropped to what is left rather than being padded around the old silhouette: `viewBox` keeps the kit's
 * own vertical extents (the petals run y≈3.4 to 22) and takes only the width the petals actually span
 * (x≈11.8 to 20.2 at the waist, 8 to 24 at the widest). A hair of margin, and no more: this is 16px, and
 * every unit spent on air is a unit off the only shape in it. */
const PETALS_BOX = "7.2 2.6 17.6 20.2";

const icon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${PETALS_BOX}" fill="${EMBER}">
  ${petals.join("\n  ")}
</svg>`;

const png = (size) =>
    sharp(Buffer.from(icon(size)))
        .png({ compressionLevel: 9 })
        .toBuffer();

/* ICO is a directory of images bolted to a header. Every entry is 16 bytes: the size byte is 0 for 256,
 * which is the format's way of fitting 256 into eight bits, and the payloads are ordinary PNGs, which
 * every browser still in use reads. */
const buildIco = (images) => {
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

const ICO_SIZES = [16, 32, 48];
const ico = buildIco(await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await png(size) }))));
await writeFile(join(PUBLIC, "favicon.ico"), ico);
console.log(`favicon.ico  ${ICO_SIZES.join("/")}  ${(ico.length / 1024).toFixed(1)} KB`);

// The vector one, at the size a browser asks for rather than at three sizes it has to pick between.
await writeFile(join(PUBLIC, "favicon.svg"), `${icon(512).replace(` width="512" height="512"`, "")}\n`);
console.log("favicon.svg");

/* 180 is what iOS pins to a home screen; 192 and 512 are what the web manifest asks for, and the larger
 * of the two is what an install prompt draws. */
for (const [size, name] of [
    [180, "apple-touch-icon.png"],
    [192, "assets/icon-192.png"],
    [512, "assets/icon-512.png"],
]) {
    const data = await png(size);
    await writeFile(join(PUBLIC, name), data);
    console.log(`${name}  ${size}×${size}  ${(data.length / 1024).toFixed(1)} KB`);
}
