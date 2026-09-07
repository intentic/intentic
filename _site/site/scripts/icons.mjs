/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FAVICON LADDER: every icon the site hands a browser, drawn from the mark in the top-left corner.
 *
 * Run: `node scripts/icons.mjs`  (from _site/site). Its output is committed.
 *
 * ONE DRAWING, NOT A SECOND LOGO. The lotus here is not redrawn: it is read out of
 * `src/components/ornaments.ts`, the same string the bar, every bullet and every frame finial render
 * from. A favicon that is a hand-copy of the logo is a logo that will one day be two logos. The crop, the
 * ember and the two leaves it drops are in `scripts/lotus.mjs`, with the reasoning, because the desktop
 * app's ladder and the browser extension's take exactly the same three decisions.
 *
 * WHAT IS LEFT HERE IS THIS SURFACE'S OWN ANSWER: which sizes a browser asks for, and in what containers.
 *
 * WHY THE SVG IS NOT ENOUGH. Modern browsers prefer `favicon.svg`, but the crawlers and feed readers
 * that fetch `/favicon.ico` by convention do not read the tag that offers it, and iOS wants a real PNG.
 * So all three ship, and this script is the one place their sizes are decided.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { buildIco, icon, petals } from "./lotus.mjs";

const PUBLIC = join(import.meta.dirname, "../public");

const paths = petals();
const png = (size) =>
    sharp(Buffer.from(icon(size, paths)))
        .png({ compressionLevel: 9 })
        .toBuffer();

const ICO_SIZES = [16, 32, 48];
const ico = buildIco(await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await png(size) }))));
await writeFile(join(PUBLIC, "favicon.ico"), ico);
console.log(`favicon.ico  ${ICO_SIZES.join("/")}  ${(ico.length / 1024).toFixed(1)} KB`);

// The vector one, at the size a browser asks for rather than at three sizes it has to pick between.
await writeFile(join(PUBLIC, "favicon.svg"), `${icon(512, paths).replace(` width="512" height="512"`, "")}\n`);
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
