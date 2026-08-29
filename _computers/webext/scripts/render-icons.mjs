import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/* The four PNGs Chrome wants, drawn from the same lotus as the favicon and the desktop app.
 *
 * ONE DRAWING, NOT A SECOND LOGO — the rule `_site/site/scripts/icons.mjs` and
 * `_editor/desktop-app/scripts/icons.mjs` both state, and the reason this file reads the mark out of
 * `_site/site/src/components/ornaments.ts` rather than carrying its own copy of the paths. An extension icon
 * that is a hand-copy of the logo is a logo that will one day be two logos. (This package briefly shipped a
 * third: an invented purple browser-with-a-cursor mark, which is exactly the failure the rule describes.)
 *
 * PETALS ONLY, EMBER, NO PLATE — the same three decisions the other two ladders take, for the reasons the
 * site's script sets out at length: the two `.42`-opacity leaves are a tonal step the eye reads at 32px and
 * mud at 16, the plate would leave the mark as the smallest thing in its own icon, and a transparent ground is
 * the only honest answer to a toolbar that is near-white on most machines and near-black on the rest. Ember
 * holds on both.
 *
 * WHY THIS IS A SCRIPT AND NOT A BUILD STEP: the PNGs are committed. They are release artifacts a store reads,
 * they change roughly never, and making every build depend on a rasteriser to reproduce four unchanging files
 * would be a slow answer to a question nobody asks. Run it when the mark changes, and commit what it writes.
 *
 *   node _computers/webext/scripts/render-icons.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const icons = join(here, "..", "static", "icons");
const ORNAMENTS = join(root, "_site/site/src/components/ornaments.ts");

// The ember, and the crop that leaves five petals filling the square. Both are literals in the site's and the
// desktop app's ladders too: they are the shape of the icon rather than of the logo, and three copies of two
// constants is the price of not making the DRAWING three copies.
const EMBER = "#e07b27";
const PETALS_BOX = "7.2 2.6 17.6 20.2";
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

const kit = readFileSync(ORNAMENTS, "utf8");
const lotus = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
if (lotus === undefined) {
    console.error(`no LOTUS export in ${ORNAMENTS}: the mark moved, and this script has to follow it.`);
    process.exit(1);
}
const all = lotus.match(/<path\b[^>]*\/>/gu) ?? [];
const petals = all.filter((path) => !path.includes('opacity=".42"'));
// The same assertion the other two make: if the leaves stop being the two `.42` paths, this would silently
// start drawing a different flower.
if (petals.length !== all.length - 2) {
    console.error(`expected two .42-opacity leaves in LOTUS, found ${all.length - petals.length}`);
    process.exit(1);
}

for (const size of SIZES) {
    // An explicit square viewport is the important half. `fitTo: width` preserved the crop's portrait aspect
    // ratio and quietly wrote 16x18 through 128x147 files under square names; Chrome then distorted them and
    // the store had no valid 128x128 icon. This is the same square viewport the site and desktop ladders use.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${PETALS_BOX}" fill="${EMBER}">\n  ${petals.join("\n  ")}\n</svg>`;
    const png = new Resvg(svg, { background: "rgba(0,0,0,0)" }).render().asPng();
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
        throw new Error(`icon-${size}.png did not render at ${size}x${size}`);
    }
    writeFileSync(join(icons, `icon-${size}.png`), png);
    console.log(`icon-${size}.png: ${png.length} bytes`);
}
