import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/* The four PNGs Chrome wants, rendered from the one SVG beside them.
 *
 * WHY THIS IS A SCRIPT AND NOT A BUILD STEP. The PNGs are committed: they are release artifacts a store reads,
 * they change roughly never, and making every build depend on a native rasteriser to reproduce four unchanging
 * files would be a slow answer to a question nobody asks. Run it when the drawing changes, and commit what it
 * writes.
 *
 * `@resvg/resvg-js` is resolved from the workspace root rather than declared as a dependency of this package,
 * for the same reason: a native module in the manifest of an extension that ships no native code is a lie
 * about what the artifact needs. If the resolve fails, this says so and does nothing — the committed PNGs are
 * still there, and the only thing lost is the ability to change them on this machine.
 *
 *   node _computers/webext/scripts/render-icons.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
// The PNGs ship; the drawing does not. static/ is copied into dist/ whole, so anything in it is in the
// artifact a store receives — and an SVG nobody reads at runtime has no business being downloaded by users.
const icons = join(here, "..", "static", "icons");
const source = join(here, "..", "assets", "icon.svg");
// Chrome's four: 16 in the toolbar and the tab strip, 32 for Windows' higher-DPI toolbars, 48 in the
// extensions page, 128 in the store listing and the install prompt.
const SIZES = [16, 32, 48, 128];

/* Resolving it is two attempts, and the second one is the honest part: nothing in this workspace DECLARES the
 * rasteriser (it arrives under the site's open-graph image generator), so the ordinary resolve misses it and
 * the store's own directory is where it actually is. Reaching in there would be indefensible in shipped code
 * and is exactly right in a tool that regenerates four committed files on a maintainer's machine. */
const require = createRequire(join(here, "..", "..", "..", "package.json"));
const root = join(here, "..", "..", "..");
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

const svg = readFileSync(source, "utf8");
for (const size of SIZES) {
    const png = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" }).render().asPng();
    writeFileSync(join(icons, `icon-${size}.png`), png);
    console.log(`icon-${size}.png: ${png.length} bytes`);
}
