import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* The small Chrome Web Store promotional tile.
 *
 * It is mandatory listing furniture, not a runtime asset, and it is generated for the same reason the icon
 * ladder is: the lotus comes out of the site's ornament kit rather than becoming another hand-copied logo.
 * No text, so it survives the store shrinking it and needs no locale variants. The right-hand rows are the
 * product in one glance — a short list of sites, each explicitly allowed — rather than another browser logo.
 *
 *   node _devices/webext/scripts/render-store-assets.mjs
 */

const here = import.meta.dirname;
const workspace = join(here, "..", "..", "..");
const out = join(here, "..", "assets", "store");
const ornaments = join(workspace, "_site/site/src/components/ornaments.ts");

const require = createRequire(join(workspace, "package.json"));
const fromStore = () => {
    const store = join(workspace, "node_modules", ".pnpm");
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
    throw new Error("@resvg/resvg-js is not installed in this workspace; the committed store asset is unchanged.");
}

const kit = readFileSync(ornaments, "utf8");
const lotus = /export const LOTUS = `([\s\S]*?)`;/u.exec(kit)?.[1];
const paths = lotus?.match(/<path\b[^>]*\/>/gu) ?? [];
if (paths.length !== 7) {
    throw new Error(`expected the shared lotus to contain seven paths, found ${paths.length}`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <rect width="440" height="280" fill="#15100b"/>
  <circle cx="78" cy="42" r="128" fill="#e07b27" opacity=".055"/>
  <circle cx="386" cy="254" r="142" fill="#c9a05c" opacity=".035"/>

  <g transform="translate(42 44) scale(5.7)" fill="#e07b27">
    ${paths.join("\n    ")}
  </g>

  <path d="M212 140h28" stroke="#c9a05c" stroke-width="2" stroke-linecap="round" opacity=".58"/>
  <circle cx="226" cy="140" r="4" fill="#e07b27"/>

  <g transform="translate(240 50)">
    <rect width="158" height="180" rx="15" fill="#211811" stroke="#c9a05c" stroke-opacity=".28"/>
    <circle cx="18" cy="18" r="3" fill="#e07b27"/>
    <circle cx="29" cy="18" r="3" fill="#9c8b73" opacity=".72"/>
    <path d="M42 18h91" stroke="#b7a68d" stroke-width="4" stroke-linecap="round" opacity=".45"/>

    <g transform="translate(14 45)">
      <rect width="130" height="31" rx="8" fill="#15100b"/>
      <circle cx="16" cy="15.5" r="4" fill="#4caf82"/>
      <path d="M29 12h56M29 19h38" stroke="#efe3cd" stroke-width="3" stroke-linecap="round" opacity=".72"/>
      <rect x="98" y="9" width="22" height="13" rx="6.5" fill="#e07b27"/>
    </g>
    <g transform="translate(14 84)">
      <rect width="130" height="31" rx="8" fill="#15100b"/>
      <circle cx="16" cy="15.5" r="4" fill="#4caf82"/>
      <path d="M29 12h48M29 19h64" stroke="#efe3cd" stroke-width="3" stroke-linecap="round" opacity=".72"/>
      <rect x="98" y="9" width="22" height="13" rx="6.5" fill="#e07b27"/>
    </g>
    <g transform="translate(14 123)">
      <rect width="130" height="31" rx="8" fill="#15100b"/>
      <circle cx="16" cy="15.5" r="4" fill="#9c8b73"/>
      <path d="M29 12h61M29 19h44" stroke="#efe3cd" stroke-width="3" stroke-linecap="round" opacity=".72"/>
      <rect x="98" y="9" width="22" height="13" rx="6.5" fill="none" stroke="#c9a05c" stroke-opacity=".65"/>
    </g>
  </g>
</svg>`;

const png = new Resvg(svg, { background: "rgba(0,0,0,0)" }).render().asPng();
if (png.readUInt32BE(16) !== 440 || png.readUInt32BE(20) !== 280) {
    throw new Error("the promotional tile did not render at 440x280");
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "promo-440x280.png"), png);
console.log(`promo-440x280.png: ${png.length} bytes`);
