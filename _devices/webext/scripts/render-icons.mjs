import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { icon, petals } from "../../../_site/site/scripts/lotus.mjs";

/* The four PNGs Chrome wants, drawn from the same lotus as the favicon and the desktop app.
 *
 * ONE DRAWING, NOT A SECOND LOGO — the rule the other two ladders state, and the reason this file takes the
 * mark from `_site/site/scripts/lotus.mjs` (which reads it out of the ornament kit) rather than carrying its
 * own copy of the paths. An extension icon that is a hand-copy of the logo is a logo that will one day be two
 * logos. (This package briefly shipped a third: an invented purple browser-with-a-cursor mark, which is
 * exactly the failure the rule describes.)
 *
 * PETALS ONLY, EMBER, NO PLATE — the same three decisions the other two ladders take, and now literally the
 * same object rather than a third copy of two constants. lotus.mjs sets out why at length.
 *
 * WHY THIS IS A SCRIPT AND NOT A BUILD STEP: the PNGs are committed. They are release artifacts a store reads,
 * they change roughly never, and making every build depend on a rasteriser to reproduce four unchanging files
 * would be a slow answer to a question nobody asks. Run it when the mark changes, and commit what it writes.
 *
 *   node _devices/webext/scripts/render-icons.mjs
 */

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
const icons = join(here, "..", "static", "icons");

// Chrome's four: 16 in the toolbar and the tab strip, 32 for Windows' higher-DPI toolbars, 48 in the
// extensions page, 128 in the store listing and the install prompt.
const SIZES = [16, 32, 48, 128];

/* Resolving the rasteriser is two attempts, and the second one is the honest part: nothing in this workspace
 * DECLARES one that this package may reach (the other two ladders use `sharp`, which each of them declares),
 * so the ordinary resolve misses and the store's own directory is where it actually is. Reaching in there
 * would be indefensible in shipped code and is exactly right in a tool that regenerates four committed files
 * on a maintainer's machine — a native dependency in the manifest of an extension that ships no native code
 * would be a lie about what the artifact needs. */
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
    // The square viewport `icon()` writes is the important half. `fitTo: width` preserved the crop's portrait
    // aspect ratio and quietly wrote 16x18 through 128x147 files under square names; Chrome then distorted
    // them and the store had no valid 128x128 icon.
    const png = new Resvg(icon(size, paths), { background: "rgba(0,0,0,0)" }).render().asPng();
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
        throw new Error(`icon-${size}.png did not render at ${size}x${size}`);
    }
    writeFileSync(join(icons, `icon-${size}.png`), png);
    console.log(`icon-${size}.png: ${png.length} bytes`);
}
