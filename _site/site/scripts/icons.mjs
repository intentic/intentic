// Favicon ladder: every icon size a browser gets, drawn from the mark in `src/components/ornaments.ts` (not a redrawn
// copy, so it can't drift). Crop/ember/leaf decisions live in `scripts/lotus.mjs`, shared with the desktop app and
// extension. Ships SVG, ICO and PNG since crawlers fetch `/favicon.ico` by convention and iOS wants a real PNG.
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

// 180 is what iOS home-screen pins to; 192 and 512 come from the web manifest, the larger for install prompts.
for (const [size, name] of [
    [180, "apple-touch-icon.png"],
    [192, "assets/icon-192.png"],
    [512, "assets/icon-512.png"],
]) {
    const data = await png(size);
    await writeFile(join(PUBLIC, name), data);
    console.log(`${name}  ${size}×${size}  ${(data.length / 1024).toFixed(1)} KB`);
}
