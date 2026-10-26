// Encodes every wallpaper master in src/assets/wallpaper/ into the AVIF rungs the board loads from
// public/assets/wallpaper/ (`pnpm --filter @intentic/web wallpaper:art`). The output is committed. A master is one
// `<name>-<dark|light>.png` per scheme; 10-bit so the soft skies don't band under the scrims drawn over them.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const here = import.meta.dirname;
const MASTERS = join(here, `../src/assets/wallpaper`);
const OUT_DIR = join(here, `../public/assets/wallpaper`);

// A GROUND is a master blurred past recognition and half drained of colour: the Silver skin's room (skins/silver.css),
// which its panes are tinted over. Small on purpose, since the blur leaves nothing a larger rung would add.
const GROUNDS = new Map([[`valley-dark`, `valley-ground`]]);

// A SKIN'S CUT of a master: the same picture, retouched for the one look that wears it. Silver's frame is mid-grey glass,
// and the valley's sunlit sky sits in its left third, which the board's crop puts right against the icon rail: next to
// that glow the rail read as near-black. Its cut keeps the mist and pulls the glow down to the mist's own level.
const CUTS = new Map([[`valley-dark`, [{ name: `valley-silver`, retouch: dimSkyGlow }]]]);

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Compresses the highlights inside a soft ellipse over the valley's sky glow (and along the left edge under it), so its
 *  brightest mist lands near the level of the mist elsewhere. Only tones above the knee move: trees and shadows keep
 *  their depth, and the weight falls off smoothly, so there is no edge to find. Works on 16-bit samples, in place. */
function dimSkyGlow(samples, width, height, channels) {
    const KNEE = 0.34;
    const SQUEEZE = 0.55;
    const DIM = 0.08;
    for (let y = 0; y < height; y++) {
        const v = y / height;
        for (let x = 0; x < width; x++) {
            const u = x / width;
            const glow = 1 - smoothstep(Math.hypot((u - 0.2) / 0.5, (v - 0.3) / 0.55));
            const edge = 0.55 * (1 - smoothstep(u / 0.35)) * (1 - smoothstep((v - 0.35) / 0.4));
            const weight = Math.max(glow, edge);
            const i = (y * width + x) * channels;
            for (let c = 0; c < 3; c++) {
                let s = samples[i + c] / 65535;
                if (s > KNEE) {s = KNEE + (s - KNEE) * (1 - SQUEEZE * weight);}
                samples[i + c] = Math.round(s * (1 - DIM * weight) * 65535);
            }
        }
    }
}

/** A master as 16-bit RGB, through a retouch, back into a pipeline: 16 bits so the soft sky keeps its 10-bit smoothness. */
async function retouched(path, retouch) {
    const { data, info } = await sharp(path).removeAlpha().toColourspace(`rgb16`).raw({ depth: `ushort` }).toBuffer({ resolveWithObject: true });
    const samples = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    retouch(samples, info.width, info.height, info.channels);
    return () => sharp(samples, { raw: { width: info.width, height: info.height, channels: info.channels } }).toColourspace(`srgb`);
}

async function encodeRungs(name, open) {
    for (const { width, quality } of RUNGS) {
        const height = Math.round((width * 9) / 16);
        const buffer = await open()
            .resize(width, height, { fit: `cover`, position: `centre`, kernel: `lanczos3` })
            .avif({ quality, effort: 9, chromaSubsampling: `4:4:4`, bitdepth: 10 })
            .toBuffer();
        const file = join(OUT_DIR, `${name}-${width}.avif`);
        await writeFile(file, buffer);
        console.log(`${file}  ${width}×${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
    }
}

// 16:9, which wallpapers.css covers from; the board is never wider than the window, so 1600 is the top rung.
const RUNGS = [
    { width: 900, quality: 56 },
    { width: 1600, quality: 58 },
];

await mkdir(OUT_DIR, { recursive: true });

for (const master of (await readdir(MASTERS)).filter((file) => file.endsWith(`.png`))) {
    const name = master.slice(0, -`.png`.length);
    await encodeRungs(name, () => sharp(join(MASTERS, master)));
    for (const cut of CUTS.get(name) ?? []) {
        await encodeRungs(cut.name, await retouched(join(MASTERS, master), cut.retouch));
    }
    const ground = GROUNDS.get(name);
    if (ground !== undefined) {
        const buffer = await sharp(join(MASTERS, master))
            .resize(480, 270, { fit: `cover`, position: `centre` })
            .blur(14)
            .modulate({ saturation: 0.35 })
            .avif({ quality: 50, effort: 9, chromaSubsampling: `4:4:4`, bitdepth: 10 })
            .toBuffer();
        const file = join(OUT_DIR, `${ground}.avif`);
        await writeFile(file, buffer);
        console.log(`${file}  480×270  ${(buffer.length / 1024).toFixed(1)} KB`);
    }
}
