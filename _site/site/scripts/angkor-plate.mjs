/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ANGKOR PLATE LADDER — regenerates the three background rungs from the one master.
 *
 * Run: `node scripts/angkor-plate.mjs`  (from _site/site)
 *
 * WHY A SCRIPT AND NOT `astro:assets`. The plate is a CSS `background-image` on `.plate-img`, chosen
 * by media query rather than by `srcset`, because it is scenery: it has no intrinsic place in the flow
 * and an `<img>` there would have to be absolutely positioned and `object-fit`ed back into exactly the
 * same thing. `astro:assets` only reaches files under `src/assets/` that are IMPORTED, so a background
 * cannot go through it. This is the pipeline instead, and its output is committed.
 *
 * WHY THE MASTER IS UPSCALED. The art arrives at 1672×941 and the widest rung is 2400. Lanczos to 1.44×
 * on a plate that is then dimmed to a fraction of its contrast is invisible; shipping a 1672 as the
 * "2400" rung and letting `cover` blow it up on a 4K display is not, because the browser's own upscale
 * is bilinear and turns the carved border into mush.
 *
 * WHY 10-BIT AVIF. This image is nine tenths near-black with long, slow ramps out of it, and it is then
 * laid under a scrim that compresses what is left into an even narrower band. Eight bits of depth band
 * visibly under that treatment — the sky behind the mandalas goes to rings. Ten bits costs about four
 * percent and every AVIF decoder that exists reads it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const MASTER = join(here, "../src/assets/angkor/temple-master.png");
const OUT_DIR = join(here, "../public/assets/angkor");

/* The three rungs the stylesheet asks for by media query: phone, everything, and the wide desktop above
 * 100rem. 16:9 exactly — the master is 1672×941, which is 16:9 to within a twentieth of a percent, and
 * pinning it to the nominal ratio keeps the frame-rule arithmetic in global.css honest at every rung.
 *
 * Quality rises as the rung shrinks: at 900 the whole plate is painted into a phone's width, so its
 * pixels are the ones a reader is closest to, while at 2400 each artefact is a third the angular size. */
const RUNGS = [
    { width: 900, quality: 54 },
    { width: 1600, quality: 50 },
    { width: 2400, quality: 46 },
];

/* ── THE LINTEL, cut from the top of the same plate ─────────────────────────────────────────────────
 *
 * The navigation bar is furniture inside the plaque's carved top band, and it has to be the SAME bar on
 * every page of the site — not a temple-framed one on the home page and a flat dark strip everywhere
 * else. Only the home page has the whole plate behind it, so every other page gets this: the top of that
 * plate and nothing more.
 *
 * IT IS 90 UNITS OF 900, and that number is measured rather than chosen. Scanning the art's row
 * luminance: the outer gold rule is a ridge at y=10, the ground behind the bar runs flat to y≈70, the
 * inner rule is a ridge at y=74, and the wall starts below it. 90 clears the inner rule with a little
 * wall under it, which is what makes the bar read as a lintel sitting ON something rather than as a
 * cropped photograph. It is also the number the bar's own height is derived from (`--bar-height` in
 * global.css is 90/1600 of the viewport), so the strip and the bar are one arithmetic.
 *
 * THE SAME RUNGS AT THE SAME QUALITY AS THE PLATE, and that is the whole reason this is cut here rather
 * than authored as its own ladder. On the home page's first screen the bar is transparent and the reader
 * is looking at the PLATE's band; a scroll later, and on every other page, they are looking at this. If
 * the two are cut from different sources or at different bitrates the carved corners come out a shade
 * crisper on one than the other, which is exactly the kind of difference nobody can name and everybody
 * feels. Same widths, same qualities, same switch points in the stylesheet: the strip is the plate's own
 * top rows and cannot drift from them. */
const BAND_UNITS = 90;

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

for (const { width, quality } of RUNGS) {
    const height = Math.round((width * 9) / 16);
    const band = Math.round((height * BAND_UNITS) / 900);
    const buffer = await sharp(MASTER)
        .resize(width, height, { fit: "fill", kernel: "lanczos3" })
        .extract({ left: 0, top: 0, width, height: band })
        .avif({ quality, effort: 9, chromaSubsampling: "4:4:4", bitdepth: 10 })
        .toBuffer();
    const file = join(OUT_DIR, `lintel-${width}.avif`);
    await writeFile(file, buffer);
    console.log(`${file}  ${width}×${band}  ${(buffer.length / 1024).toFixed(1)} KB`);
}
