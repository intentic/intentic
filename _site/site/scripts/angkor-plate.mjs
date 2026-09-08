// Regenerates the three background rungs from the master plate (`node scripts/angkor-plate.mjs`, from _site/site). It's
// a CSS background-image by media query, not astro:assets (imports only); output is committed. The master is upscaled
// deliberately, and encoded as 10-bit AVIF to avoid banding under the dark scrim.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

const here = import.meta.dirname;
const MASTER = join(here, "../src/assets/angkor/temple-master.png");
const OUT_DIR = join(here, "../public/assets/angkor");

// Pinned to 16:9, matching global.css's frame math; quality drops as width grows (artefacts shrink angularly).
const RUNGS = [
    { width: 900, quality: 54 },
    { width: 1600, quality: 50 },
    { width: 2400, quality: 46 },
];

await mkdir(OUT_DIR, { recursive: true });

for (const { width, quality } of RUNGS) {
    const height = Math.round((width * 9) / 16);
    const buffer = await sharp(MASTER)
        .resize(width, height, { fit: "fill", kernel: "lanczos3" })
        .avif({ quality, effort: 9, chromaSubsampling: "4:4:4", bitdepth: 10 })
        .toBuffer();
    const file = join(OUT_DIR, `temple-${width}.avif`);
    await writeFile(file, buffer);
    console.log(`${file}  ${width}×${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
}
