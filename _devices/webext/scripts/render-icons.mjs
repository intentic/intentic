import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { icon, petals } from "../../../_site/site/scripts/lotus.mjs";

// The four Chrome PNGs, drawn from the same lotus mark as the favicon and desktop app
// (`_site/site/scripts/lotus.mjs`) rather than a hand-copied logo. Committed artifacts, not a build step, since
// they change roughly never; run when the mark changes and commit what it writes.
// node _devices/webext/scripts/render-icons.mjs

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
const icons = join(here, "..", "static", "icons");

// Chrome's four icon sizes:
// 16 - toolbar and tab strip
// 32 - Windows' higher-DPI toolbars
// 48 - extensions page
// 128 - store listing and install prompt
const SIZES = [16, 32, 48, 128];

// Two-attempt resolve: nothing in this workspace declares `@resvg/resvg-js` directly, so the ordinary resolve
// misses and the pnpm store is reached into directly, fine for a maintainer's regeneration script but wrong in shipped
// code.
const require = createRequire(join(root, "package.json"));
const fromStore = () => {
    const store = join(root, "node_modules", ".pnpm");
    const hit = readdirSync(store).find((entry) => entry.startsWith("@resvg+resvg-js@"));
    return hit === undefined ? undefined : require(join(store, hit, "node_modules", "@resvg", "resvg-js"));
};
let Resvg;
try {
    ({ Resvg } = require("@resvg/resvg-js"));
} catch {
    ({ Resvg } = fromStore() ?? {});
}
if (Resvg === undefined) {
    console.error("@resvg/resvg-js is not installed in this workspace; the committed PNGs are unchanged.");
    process.exit(1);
}

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
