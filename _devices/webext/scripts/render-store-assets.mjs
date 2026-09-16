import { createRequire } from "node:module";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { lotusPaths } from "../../../_site/site/scripts/lotus.mjs";

/* The small Chrome Web Store promotional tile. */

// The store refuses a promotional tile with an alpha channel, and resvg only emits RGBA — so the PNG is encoded here
// from raw pixels with every fourth byte dropped, rather than rendered and then converted.
const rgbPng = (pixels, width, height) => {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        // Filter byte 0 (none) per scanline: the tile is flat colour, where filtering buys nothing.
        raw[y * (stride + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const from = (y * width + x) * 4;
            const to = y * (stride + 1) + 1 + x * 3;
            raw[to] = pixels[from];
            raw[to + 1] = pixels[from + 1];
            raw[to + 2] = pixels[from + 2];
        }
    }
    const chunk = (type, body) => {
        const head = Buffer.from(type, "ascii");
        const out = Buffer.alloc(body.length + 12);
        out.writeUInt32BE(body.length, 0);
        head.copy(out, 4);
        body.copy(out, 8);
        out.writeUInt32BE(crc32(Buffer.concat([head, body])) >>> 0, body.length + 8);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    // Colour type 2: truecolour, no alpha — the byte the store actually checks.
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
};

const here = import.meta.dirname;
const workspace = join(here, "..", "..", "..");
const out = join(here, "..", "assets", "store");

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

// The whole flower, leaves included, unlike the icon ladders: at 440x280 there is room for it. Through the shared
// helper rather than a second regex over ornaments.ts — the copy that used to live here is what went stale when the
// mark was split into LOTUS_PETALS and its `<svg>` wrapper.
const paths = lotusPaths();
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

// Opaque background rather than transparent: with no alpha to carry it, an unpainted edge would encode as black.
const rendered = new Resvg(svg, { background: "#15100b" }).render();
const png = rgbPng(rendered.pixels, rendered.width, rendered.height);
if (png.readUInt32BE(16) !== 440 || png.readUInt32BE(20) !== 280) {
    throw new Error("the promotional tile did not render at 440x280");
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "promo-440x280.png"), png);
console.log(`promo-440x280.png: ${png.length} bytes`);
