// Regenerates the three background rungs from the master plate (`node scripts/plate-art.mjs`, from _site/site). It's
// a CSS background-image by media query, not astro:assets (imports only); output is committed. The master is upscaled
// deliberately, and encoded as 10-bit AVIF to avoid banding under the dark scrim.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

const here = import.meta.dirname;
const OUT_DIR = join(here, "../public/assets/plate");

// One plate per skin, and they are different pictures rather than one picture lit twice. The dark skin's is a
// photograph of a temple wall, dark enough that cream type sits on it. The desk skin's is drawn: cream parchment,
// the same apsaras and spires, a gold cartouche border, and an empty middle for the headline. Washing the
// photograph out to paper was tried first and is not the same thing — it reads as a faded photo, not as a page.
const PLATES = [
    { master: "temple-master.png", prefix: "temple" },
    { master: "temple-desk-master.png", prefix: "temple-desk" },
];

// Pinned to 16:9, matching global.css's frame math; quality drops as width grows (artefacts shrink angularly).
const RUNGS = [
    { width: 900, quality: 54 },
    { width: 1600, quality: 50 },
    { width: 2400, quality: 46 },
];

await mkdir(OUT_DIR, { recursive: true });

for (const { master, prefix } of PLATES) {
    for (const { width, quality } of RUNGS) {
        const height = Math.round((width * 9) / 16);
        const buffer = await sharp(join(here, "../src/assets/plate", master))
            .resize(width, height, { fit: "fill", kernel: "lanczos3" })
            .avif({ quality, effort: 9, chromaSubsampling: "4:4:4", bitdepth: 10 })
            .toBuffer();
        const file = join(OUT_DIR, `${prefix}-${width}.avif`);
        await writeFile(file, buffer);
        console.log(`${file}  ${width}×${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
    }
}
