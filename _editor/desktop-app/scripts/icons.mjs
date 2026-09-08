// Builds every icon container the Tauri bundle needs, from the shared lotus drawing in
// _site/site/scripts/lotus.mjs — not a redrawn logo. Run `node scripts/icons.mjs` from _editor/desktop-app; output
// goes to src-tauri/icons/ and is committed.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { buildIco, icon, petals } from "../../../_site/site/scripts/lotus.mjs";

const OUT = join(import.meta.dirname, "..", "src-tauri/icons");

const paths = petals();
const png = (size) =>
    sharp(Buffer.from(icon(size, paths)))
        .png({ compressionLevel: 9 })
        .toBuffer();

/* ICNS is a typed container of PNG layers. The set mirrors what `tauri icon` writes via icns.json. */
const ICNS_LAYERS = [
    [16, "icp4"],
    [32, "icp5"],
    [64, "icp6"],
    [128, "ic07"],
    [256, "ic08"],
    [512, "ic09"],
    [1024, "ic10"],
];

const buildIcns = (layers) => {
    const parts = [];
    for (const [, type, pngData] of layers) {
        const header = Buffer.alloc(8);
        header.write(type, 0, 4, "ascii");
        header.writeUInt32BE(8 + pngData.length, 4);
        parts.push(header, pngData);
    }
    const body = Buffer.concat(parts);
    const wrapper = Buffer.alloc(8);
    wrapper.write("icns", 0, 4, "ascii");
    wrapper.writeUInt32BE(8 + body.length, 4);
    return Buffer.concat([wrapper, body]);
};

await mkdir(OUT, { recursive: true });

/* Linux / general PNG ladder — same names `tauri icon` emits. */
const PNG_SIZES = [
    [32, "32x32.png"],
    [64, "64x64.png"],
    [128, "128x128.png"],
    [256, "128x128@2x.png"],
    [512, "icon.png"],
];

for (const [size, name] of PNG_SIZES) {
    const data = await png(size);
    await writeFile(join(OUT, name), data);
    console.log(`${name}  ${size}×${size}  ${(data.length / 1024).toFixed(1)} KB`);
}

/* Windows Appx / NSIS square logos. */
await writeFile(join(OUT, "StoreLogo.png"), await png(50));
console.log("StoreLogo.png  50×50");

for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    const name = `Square${size}x${size}Logo.png`;
    const data = await png(size);
    await writeFile(join(OUT, name), data);
    console.log(`${name}  ${size}×${size}  ${(data.length / 1024).toFixed(1)} KB`);
}

/* ICO: Tauri's layer order — 32 first for dev display, 256 as PNG-compressed. */
const ICO_SIZES = [32, 16, 24, 48, 64, 256];
const ico = buildIco(await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await png(size) }))));
await writeFile(join(OUT, "icon.ico"), ico);
console.log(`icon.ico  ${ICO_SIZES.join("/")}  ${(ico.length / 1024).toFixed(1)} KB`);

/* ICNS: one PNG per layer type. */
const icnsLayers = await Promise.all(ICNS_LAYERS.map(async ([size, type]) => [size, type, await png(size)]));
await writeFile(join(OUT, "icon.icns"), buildIcns(icnsLayers));
console.log(`icon.icns  ${ICNS_LAYERS.map(([s]) => s).join("/")}  ${(icnsLayers.reduce((n, [, , d]) => n + d.length, 8) / 1024).toFixed(1)} KB`);
