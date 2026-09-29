// Encodes every wallpaper master in src/assets/wallpaper/ into the AVIF rungs the board loads from
// public/assets/wallpaper/ (`pnpm --filter @intentic/web wallpaper:art`). The output is committed. A master is one
// `<name>-<dark|light>.png` per scheme; 10-bit so the soft skies don't band under the scrims drawn over them.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// sharp is a dependency of @intentic/site, not @intentic/web.
const require = createRequire(fileURLToPath(new URL(`../../../_site/site/package.json`, import.meta.url)));
const sharp = require(`sharp`);

const here = import.meta.dirname;
const MASTERS = join(here, `../src/assets/wallpaper`);
const OUT_DIR = join(here, `../public/assets/wallpaper`);

// 16:9, which wallpapers.css covers from; the board is never wider than the window, so 1600 is the top rung.
const RUNGS = [
    { width: 900, quality: 56 },
    { width: 1600, quality: 58 },
];

await mkdir(OUT_DIR, { recursive: true });

for (const master of (await readdir(MASTERS)).filter((file) => file.endsWith(`.png`))) {
    const name = master.slice(0, -`.png`.length);
    for (const { width, quality } of RUNGS) {
        const height = Math.round((width * 9) / 16);
        const buffer = await sharp(join(MASTERS, master))
            .resize(width, height, { fit: `cover`, position: `centre`, kernel: `lanczos3` })
            .avif({ quality, effort: 9, chromaSubsampling: `4:4:4`, bitdepth: 10 })
            .toBuffer();
        const file = join(OUT_DIR, `${name}-${width}.avif`);
        await writeFile(file, buffer);
        console.log(`${file}  ${width}×${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
    }
}
