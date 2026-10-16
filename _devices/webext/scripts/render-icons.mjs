import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

import { icon, petals } from "../../../_site/site/scripts/lotus.mjs";

// The four Chrome PNGs, drawn from the same lotus mark as the favicon and desktop app
// (`_site/site/scripts/lotus.mjs`) rather than a hand-copied logo. Committed artifacts, not a build step, since
// they change roughly never; run when the mark changes and commit what it writes.
// node _devices/webext/scripts/render-icons.mjs

const here = import.meta.dirname;
const icons = join(here, "..", "static", "icons");

// Chrome's four icon sizes:
// 16 - toolbar and tab strip
// 32 - Windows' higher-DPI toolbars
// 48 - extensions page
// 128 - store listing and install prompt
const SIZES = [16, 32, 48, 128];

const paths = petals();

for (const size of SIZES) {
    // Verifies each PNG renders square: a non-square crop (e.g. from `fitTo: width`) would silently ship a
    // wrong-sized icon under a square name.
    const png = new Resvg(icon(size, paths), { background: "rgba(0,0,0,0)" }).render().asPng();
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
        throw new Error(`icon-${size}.png did not render at ${size}x${size}`);
    }
    writeFileSync(join(icons, `icon-${size}.png`), png);
    console.log(`icon-${size}.png: ${png.length} bytes`);
}
