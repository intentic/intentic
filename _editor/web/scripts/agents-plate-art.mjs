// Regenerates the agents-board background rungs from the master plate
// (`node scripts/agents-plate-art.mjs`, from _editor/web). Output is committed; the master is encoded as 10-bit AVIF
// to avoid banding under the dark scrim.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// sharp is a dependency of @intentic/site, not @intentic/web.
const require = createRequire(fileURLToPath(new URL("../../../_site/site/package.json", import.meta.url)));
const sharp = require("sharp");

const here = import.meta.dirname;
const MASTER = join(here, "../src/assets/plate/agents-master.png");
const OUT_DIR = join(here, "../public/assets/plate");

// Pinned to 16:9, matching sanctum.css's frame math; only two rungs — the board never needs the hero's 2400px rung.
const RUNGS = [
    { width: 900, quality: 54 },
    { width: 1600, quality: 50 },
];

await mkdir(OUT_DIR, { recursive: true });

for (const { width, quality } of RUNGS) {
    const height = Math.round((width * 9) / 16);
    const buffer = await sharp(MASTER)
        .resize(width, height, { fit: "cover", position: "centre", kernel: "lanczos3" })
        .avif({ quality, effort: 9, chromaSubsampling: "4:4:4", bitdepth: 10 })
        .toBuffer();
    const file = join(OUT_DIR, `agents-${width}.avif`);
    await writeFile(file, buffer);
    console.log(`${file}  ${width}×${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
}
