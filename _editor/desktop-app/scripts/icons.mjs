/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DESKTOP ICON LADDER: every icon the Tauri bundle hands an OS, drawn from the same lotus as the site.
 *
 * Run: `node scripts/icons.mjs`  (from _editor/desktop-app). Its output is committed.
 *
 * ONE DRAWING, NOT A SECOND LOGO. The lotus here is not redrawn: it is read out of
 * `_site/site/src/components/ornaments.ts`, the same string the bar, every bullet, every frame finial,
 * and `scripts/icons.mjs` on the site render from. A desktop icon that is a hand-copy of the logo is a
 * logo that will one day be two logos — which is what the old letterform bitmaps in src-tauri/icons/ were.
 *
 * The petal-only crop and the ember fill match the site's favicon script exactly: at tray and taskbar
 * sizes the leaves are mud and the plate is a smudge, so five petals fill the square on a transparent
 * ground. See _site/site/scripts/icons.mjs for that reasoning in full.
 *
 * Output lands in src-tauri/icons/, the directory tauri.conf.json already names.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(here, "..");
const ORNAMENTS = join(DESKTOP, "../../_site/site/src/components/ornaments.ts");
const OUT = join(DESKTOP, "src-tauri/icons");

const EMBER = "#e07b27";

const kit = await readFile(ORNAMENTS, "utf8");
const lotusSvg = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
if (!lotusSvg) throw new Error(`No LOTUS export found in ${ORNAMENTS}`);
const allPaths = lotusSvg.match(/<path\b[^>]*\/>/gu) ?? [];
const petals = allPaths.filter((path) => !path.includes('opacity=".42"'));
if (petals.length !== allPaths.length - 2) {
    throw new Error(`Expected two .42-opacity leaves in LOTUS, found ${allPaths.length - petals.length}`);
}

const PETALS_BOX = "7.2 2.6 17.6 20.2";

const icon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${PETALS_BOX}" fill="${EMBER}">
  ${petals.join("\n  ")}
</svg>`;

const png = (size) =>
    sharp(Buffer.from(icon(size)))
        .png({ compressionLevel: 9 })
        .toBuffer();

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
const icnsLayers = await Promise.all(
    ICNS_LAYERS.map(async ([size, type]) => [size, type, await png(size)]),
);
await writeFile(join(OUT, "icon.icns"), buildIcns(icnsLayers));
console.log(`icon.icns  ${ICNS_LAYERS.map(([s]) => s).join("/")}  ${(icnsLayers.reduce((n, [, , d]) => n + d.length, 8) / 1024).toFixed(1)} KB`);
