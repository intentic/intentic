/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FAVICON LADDER — every icon the site hands a browser, drawn from the mark in the top-left corner.
 *
 * Run: `node scripts/icons.mjs`  (from _site/site). Its output is committed.
 *
 * ONE DRAWING, NOT A SECOND LOGO. The lotus here is not redrawn: it is read out of
 * `src/components/ornaments.ts`, the same string the bar, every bullet and every frame finial render
 * from. A favicon that is a hand-copy of the logo is a logo that will one day be two logos.
 *
 * WHY IT IS ON A PLATE RATHER THAN TRANSPARENT. A tab strip is white on most machines and near-black on
 * the rest, and ember on white is a smudge. The mark keeps its own warm ground — the site's canvas —
 * so it reads the same wherever a browser puts it, and the glow behind it stops 16px of flat black
 * looking like a failed download.
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

/* The site's own colours, from global.css: the warm near-black everything sits on, and the one ember
 * the brand spends. Named here rather than imported because a stylesheet is not a module. */
const CANVAS = "#0c0907";
const EMBER = "#e07b27";

/* The lotus, lifted out of the ornament kit rather than pasted. The kit exports it as a template
 * literal holding a whole <svg>; what is wanted is the paths inside it and the viewBox it is drawn on. */
const kit = await readFile(ORNAMENTS, "utf8");
const lotusSvg = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
if (!lotusSvg) throw new Error(`No LOTUS export found in ${ORNAMENTS}`);
const viewBox = /viewBox="([^"]+)"/u.exec(lotusSvg)?.[1];
const paths = lotusSvg
    .replace(/^[\s\S]*?<svg[^>]*>/u, "")
    .replace(/<\/svg>[\s\S]*$/u, "")
    .trim();
if (!viewBox) throw new Error("The LOTUS drawing has no viewBox to scale from");

/* THE MARK TAKES 68% OF THE PLATE. Tighter and it reads as a dot at 16px; looser and the petals touch
 * the edge, which on a browser's own rounded tab chip clips them. */
const INSET = (1 - 0.68) / 2;

const icon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1 1">
  <rect width="1" height="1" fill="${CANVAS}"/>
  <circle cx="0.5" cy="0.56" r="0.46" fill="${EMBER}" opacity="0.14"/>
  <svg x="${INSET}" y="${INSET}" width="${1 - 2 * INSET}" height="${1 - 2 * INSET}" viewBox="${viewBox}" fill="${EMBER}">
    ${paths}
  </svg>
</svg>`;

const png = (size) =>
    sharp(Buffer.from(icon(size)))
        .png({ compressionLevel: 9 })
        .toBuffer();

/* ICO is a directory of images bolted to a header. Every entry is 16 bytes — the size byte is 0 for 256,
 * which is the format's way of fitting 256 into eight bits — and the payloads are ordinary PNGs, which
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
await writeFile(join(PUBLIC, "favicon.svg"), `${icon(512).replace(' width="512" height="512"', "")}\n`);
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
