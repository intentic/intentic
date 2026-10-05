// Frames the README's photographs and draws its diagrams: each picture is a small HTML page in the site's carved
// style (gold hairlines, turned corners, the lotus), rendered by Chromium at 2x and written once per look.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { FONTS, LOTUS, PLATES, corners } from "./art.mjs";
import { DIAGRAMS } from "./diagrams.mjs";

const font = (family, file, weight) =>
    `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url("${pathToFileURL(join(FONTS, file))}") format("woff2"); }`;

const FACES = [
    font("Public Sans", "public-sans-100-900-latin.woff2", "100 900"),
    font("Spectral", "spectral-300-latin.woff2", 300),
    font("Spectral", "spectral-400-latin.woff2", 400),
    font("Spectral", "spectral-500-latin.woff2", 500),
    font("Baloo 2", "baloo-2-400-800-latin.woff2", "400 800"),
    font("JetBrains Mono", "jetbrains-mono-100-800-latin.woff2", "100 800"),
].join("\n");

// The site's two skins, resolved to the handful of roles a picture needs (global.css is dark, desk.css is light).
const TOKENS = {
    dark: `
        --ink: #efe3cd; --muted: #b7a68d; --subtle: #8f7f69;
        --gold: #c9a05c; --gold-bright: #e5c489; --ember: #e07b27; --ember-ink: #f59b3f;
        --ember-wash: rgba(224, 123, 39, 0.14);
        --line: rgba(201, 160, 92, 0.16); --line-strong: rgba(201, 160, 92, 0.32); --line-bright: rgba(201, 160, 92, 0.55);
        --window: #0f0b08; --rail: linear-gradient(180deg, #261c13, #130e0a);
        --panel: #110c08; --card: #1a130d; --card-2: #22180f;
        --shadow: 0 2px 0 rgba(201, 160, 92, 0.06), 0 30px 70px -18px rgba(0, 0, 0, 0.95), 0 0 0 1px rgba(0, 0, 0, 0.4);
        --glow: 0 0 60px -20px rgba(224, 123, 39, 0.55);
        --ok: oklch(72% 0.13 148); --bad: oklch(68% 0.17 30);
        --bezel: #0b0806;`,
    light: `
        --ink: #2b211a; --muted: #62564e; --subtle: #8b7d71;
        --gold: oklch(44% 0.115 46); --gold-bright: oklch(50% 0.135 48); --ember: #e07b27; --ember-ink: oklch(56% 0.16 50);
        --ember-wash: rgba(224, 123, 39, 0.1);
        --line: #eadfd5; --line-strong: #dccbbd; --line-bright: #c99f7d;
        --window: #fffcf9; --rail: linear-gradient(180deg, #f5ece3, #fffbf7);
        --panel: #fbf6f0; --card: #fffdfa; --card-2: #f6eee6;
        --shadow: 0 2px 4px rgb(61 40 22 / 0.07), 0 24px 56px -16px rgb(61 40 22 / 0.32), 0 0 0 1px rgb(61 40 22 / 0.04);
        --glow: 0 0 60px -24px rgba(224, 123, 39, 0.45);
        --ok: oklch(48% 0.12 150); --bad: oklch(50% 0.2 27);
        --bezel: #201812;`,
};

const BASE_CSS = `
${FACES}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: transparent; }
body { font-family: "Public Sans", sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
.stage { position: relative; display: inline-block; }
.corner { position: absolute; width: var(--corner, 26px); height: var(--corner, 26px); color: var(--gold); z-index: 3; }
.corner svg { display: block; width: 100%; height: 100%; }
.corner.tl { top: -1px; left: -1px; }
.corner.tr { top: -1px; right: -1px; transform: scaleX(-1); }
.corner.bl { bottom: -1px; left: -1px; transform: scaleY(-1); }
.corner.br { bottom: -1px; right: -1px; transform: scale(-1); }
.lotus { display: inline-block; color: var(--ember); }
.lotus svg { display: block; width: 100%; height: 100%; }
.finial { position: absolute; top: 0; left: 50%; width: 30px; height: 30px; transform: translate(-50%, -58%); z-index: 4;
  filter: drop-shadow(0 0 10px rgba(224, 123, 39, 0.45)); }
.win { position: relative; background: var(--window); border: 1px solid var(--line-strong); box-shadow: var(--shadow); }
.win .rail { height: var(--corner, 26px); border-bottom: 1px solid var(--line); background: var(--rail);
  display: flex; align-items: center; justify-content: flex-end; padding: 0 34px; }
.win .addr { font: 400 9.5px/1 "JetBrains Mono", monospace; color: var(--subtle); }
.win .view { position: relative; overflow: hidden; }
.win .view img { display: block; }
.win .view.fade::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 70px;
  background: linear-gradient(180deg, transparent, var(--window)); }
.phone { position: relative; border-radius: 40px; padding: 9px; background: var(--bezel);
  box-shadow: var(--shadow), inset 0 0 0 1px var(--line-strong); }
.phone::before { content: ""; position: absolute; inset: -1px; border-radius: 41px; border: 1px solid var(--line-bright); opacity: 0.6; }
.phone .screen { position: relative; border-radius: 31px; overflow: hidden; }
.phone .screen img { display: block; width: 100%; }
.phone .status { position: relative; height: 30px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 22px 0 26px; font: 600 11.5px/1 "Public Sans"; }
.phone .status svg { height: 10px; }
.phone .island { position: absolute; top: 8px; left: 50%; width: 74px; height: 20px; transform: translateX(-50%);
  border-radius: 12px; background: #050403; }
`;

const rawFile = (rawDir, name, look) => join(rawDir, `${name}-${look}.png`);
const img = (rawDir, name, look) => pathToFileURL(rawFile(rawDir, name, look)).href;
const phoneShot = async (rawDir, name, look, width) =>
    phoneFrame({ src: img(rawDir, name, look), width, ...(await edge(rawFile(rawDir, name, look))) });

/**
 * A screenshot in the site's window: hairline, turned corners, a ledge naming where it was taken. `source` is the
 * capture's CSS size; `area` (CSS pixels of the capture) keeps only that part of it, so a frame can close in on what
 * the paragraph beside it is about.
 */
export const windowFrame = ({ src, label, width, source, area, fade = false, finial = false }) => {
    const { x = 0, y = 0, w = source.width, h = source.height } = area ?? {};
    const scale = width / w;
    return `<div class="win" style="width:${width}px">
        ${corners()}${finial ? `<span class="finial lotus">${LOTUS}</span>` : ""}
        <div class="rail">${label ? `<span class="addr">${label}</span>` : ""}</div>
        <div class="view${fade ? " fade" : ""}" style="height:${Math.round(h * scale)}px"><img src="${src}" style="width:${Math.round(source.width * scale)}px; margin:${-Math.round(y * scale)}px 0 0 ${-Math.round(x * scale)}px"></div>
    </div>`;
};

// A phone's own status bar over the app, in the colour of the app's top edge, so the island never sits on content.
const STATUS_ICONS = `<svg viewBox="0 0 46 10" fill="currentColor" aria-hidden="true"><rect x="0" y="6" width="2.4" height="4" rx=".6"/><rect x="3.6" y="4.5" width="2.4" height="5.5" rx=".6"/><rect x="7.2" y="3" width="2.4" height="7" rx=".6"/><rect x="10.8" y="1.2" width="2.4" height="8.8" rx=".6"/><path d="M22 2.2a8.5 8.5 0 0 1 6.1 2.5l-1.1 1.1A7 7 0 0 0 22 3.8a7 7 0 0 0-5 2l-1.1-1.1A8.5 8.5 0 0 1 22 2.2zm0 3a5.5 5.5 0 0 1 3.9 1.6l-1.1 1.1a4 4 0 0 0-5.6 0l-1.1-1.1A5.5 5.5 0 0 1 22 5.2zm0 3a2.4 2.4 0 0 1 1.7.7L22 10.6l-1.7-1.7a2.4 2.4 0 0 1 1.7-.7z"/><rect x="31.5" y="1" width="12" height="8" rx="2.2" fill="none" stroke="currentColor" stroke-opacity=".5"/><rect x="33" y="2.5" width="8" height="5" rx="1.1"/><rect x="44.3" y="3.6" width="1.4" height="2.8" rx=".6" opacity=".5"/></svg>`;

/** `top` is the app's colour at its top edge, `ink` the status bar's text colour on it. */
export const phoneFrame = ({ src, width, top, ink }) => `<div class="phone" style="width:${width}px">
    <div class="screen" style="background:${top}"><div class="status" style="color:${ink}"><span>9:41</span><span class="island"></span>${STATUS_ICONS}</div><img src="${src}"></div></div>`;

/** The colour of a capture's top edge, and a readable ink for it. */
const edge = async (file) => {
    const [r, g, b] = await sharp(file).extract({ left: 6, top: 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
    return { top: `rgb(${r} ${g} ${b})`, ink: light ? "#1d1611" : "#f3ead9" };
};

// Every framed screenshot: the raw capture's name, its CSS size, the ledge label and how much of it to keep.
const FEATURES = [
    { name: "board", source: { width: 1280, height: 860 }, label: "acme-shop · /agents", area: { h: 760 }, fade: true },
    { name: "plan", source: { width: 1280, height: 900 }, label: "acme-shop · /chat" },
    { name: "review", source: { width: 1240, height: 780 }, label: "acme-shop · /agents/soft-deletes", area: { h: 500 } },
    // The meters, without the settings column beside them.
    {
        name: "usage",
        source: { width: 1400, height: 1180 },
        label: "acme-shop · /sandbox/usage",
        area: { x: 392, y: 62, w: 1008, h: 880 },
        fade: true,
    },
    // The catalogue's categories and the GitHub card, down to what it adds to the sandbox.
    {
        name: "capabilities",
        source: { width: 1280, height: 860 },
        label: "acme-shop · /capabilities/github",
        area: { x: 64, y: 118, w: 1130, h: 642 },
    },
    { name: "automations", source: { width: 1120, height: 700 }, label: "acme-shop · /ext/automations", area: { h: 640 }, fade: true },
];

const page = (look, body, extraCss = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><style>:root{${TOKENS[look]}} ${BASE_CSS} ${extraCss}</style></head><body>${body}</body></html>`;

const SCENES = [
    // HERO: the whole fleet in its window over the temple plate, and the same board on a phone beside it.
    {
        name: "hero",
        format: "jpeg",
        build: async ({ look, rawDir }) => {
            const plate = pathToFileURL(join(PLATES, look === "dark" ? "temple-master.png" : "temple-desk-master.png")).href;
            const vignette =
                look === "dark"
                    ? "radial-gradient(120% 95% at 50% 38%, transparent 52%, rgba(5, 3, 2, 0.6))"
                    : "radial-gradient(120% 95% at 50% 38%, transparent 58%, rgba(120, 80, 40, 0.12))";
            const css = `
              .hero { position: relative; width: 1280px; height: 770px; overflow: hidden; }
              .hero .plate { position: absolute; inset: 0; background: url("${plate}") center bottom / cover no-repeat;
                filter: ${look === "dark" ? "brightness(1.3) saturate(1.1)" : "none"}; }
              .hero::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: ${vignette}; }
              .hero .halo { position: absolute; left: 120px; right: 120px; top: 140px; height: 520px; border-radius: 50%;
                background: radial-gradient(closest-side, rgba(224, 123, 39, ${look === "dark" ? 0.2 : 0.12}), transparent); }
              .hero .app { position: absolute; left: 52px; top: 70px; z-index: 1; }
              .hero .hand { position: absolute; right: 54px; top: 120px; z-index: 2; }`;
            const body = `<div class="hero"><div class="plate"></div><div class="halo"></div>
                <div class="app">${windowFrame({ src: img(rawDir, "hero-app", look), label: "acme-shop.intentic.dev · /agents", width: 912, source: { width: 1760, height: 1000 }, finial: true })}</div>
                <div class="hand">${await phoneShot(rawDir, "hero-phone", look, 236)}</div></div>`;
            return { html: page(look, body, css), selector: ".hero" };
        },
    },
    // The repository's social preview (Settings, Social preview): 1280x640, the brand line beside the board.
    {
        name: "social",
        format: "jpeg",
        resize: { width: 1280, height: 640 },
        build: ({ look, rawDir }) => {
            const plate = pathToFileURL(join(PLATES, look === "dark" ? "temple-master.png" : "temple-desk-master.png")).href;
            const css = `
              .card { position: relative; width: 1280px; height: 640px; overflow: hidden; }
              .card .plate { position: absolute; inset: 0; background: url("${plate}") center bottom / cover no-repeat;
                filter: ${look === "dark" ? "brightness(1.3)" : "none"}; }
              .card .veil { position: absolute; inset: 0; background: linear-gradient(90deg, ${look === "dark" ? "rgba(10,7,5,.92) 0%, rgba(10,7,5,.75) 40%, transparent 70%" : "rgba(250,244,237,.95) 0%, rgba(250,244,237,.8) 40%, transparent 70%"}); }
              .words { position: absolute; left: 72px; top: 92px; width: 520px; z-index: 2; }
              .brand { display: flex; align-items: center; gap: 12px; color: var(--ember-ink); font: 600 40px/1 "Baloo 2"; }
              .brand .lotus { width: 46px; height: 46px; color: var(--ember); }
              .line { margin-top: 40px; font: 300 52px/1.12 "Spectral", serif; color: var(--ink); letter-spacing: -0.01em; }
              .line i { font-style: normal; color: var(--ember); }
              .sub { margin-top: 26px; font: 400 22px/1.4 "Public Sans"; color: var(--muted); }
              .shot { position: absolute; left: 640px; top: 96px; z-index: 1; }`;
            const line = ["More work", "Less AI waste", "Same subscriptions"].map((beat) => `${beat}<i>.</i>`).join("<br>");
            const body = `<div class="card"><div class="plate"></div><div class="veil"></div>
                <div class="words"><div class="brand"><span class="lotus">${LOTUS}</span>intentic</div><div class="line">${line}</div>
                <div class="sub">The open-source workspace for coding agents, on your own machine.</div></div>
                <div class="shot">${windowFrame({ src: img(rawDir, "hero-app", look), label: "acme-shop · /agents", width: 900, source: { width: 1760, height: 1000 }, finial: true })}</div></div>`;
            return { html: page(look, body, css), selector: ".card" };
        },
    },
    // Three phones: the board, an agent's report, the diff — the same sandbox, away from the desk.
    {
        name: "phones",
        build: async ({ look, rawDir }) => {
            const css = `.row { display: inline-flex; gap: 40px; padding: 36px 48px 30px; align-items: flex-start; }
              .col { width: 256px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
              .col:nth-child(2) { margin-top: 30px; }
              .cap { font: 500 14px/1.35 "Public Sans"; color: var(--muted); text-align: center; display: flex; gap: 8px; align-items: baseline; }
              .cap .lotus { width: 13px; height: 13px; flex: none; transform: translateY(1px); }`;
            const shots = [
                ["phone-board", "Every agent, sorted by who needs you"],
                ["phone-review", "An agent's report, on its own branch"],
                ["phone-changes", "Every changed file, before it lands"],
            ];
            const cols = [];
            for (const [name, cap] of shots) {
                cols.push(
                    `<div class="col">${await phoneShot(rawDir, name, look, 256)}<div class="cap"><span class="lotus">${LOTUS}</span><span>${cap}</span></div></div>`,
                );
            }
            return { html: page(look, `<div class="row">${cols.join("")}</div>`, css), selector: ".row", transparent: true };
        },
    },
    ...FEATURES.map((feature) => ({
        name: feature.name,
        build: ({ look, rawDir }) => ({
            html: page(
                look,
                `<div class="pad">${windowFrame({ ...feature, src: img(rawDir, feature.name, look), width: 880 })}</div>`,
                ".pad { padding: 18px 22px 34px; display: inline-block; }",
            ),
            selector: ".pad",
            transparent: true,
        }),
    })),
    ...DIAGRAMS.map((diagram) => ({
        name: diagram.name,
        build: ({ look }) => ({ html: page(look, diagram.html(look), diagram.css(look)), selector: diagram.selector, transparent: true }),
    })),
];

/** Renders every scene (or the named subset) for both looks into `outDir`. */
export const compose = async ({ rawDir, outDir, only = [] }) => {
    mkdirSync(outDir, { recursive: true });
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
        const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 900 } });
        const tab = await context.newPage();
        for (const scene of SCENES.filter((s) => only.length === 0 || only.includes(s.name))) {
            for (const look of ["dark", "light"]) {
                const { html, selector, transparent = false } = await scene.build({ look, rawDir });
                const file = join(rawDir, `scene-${scene.name}-${look}.html`);
                writeFileSync(file, html);
                await tab.goto(pathToFileURL(file).href);
                await tab.evaluate(() => document.fonts.ready);
                await tab.waitForFunction(() => [...document.images].every((image) => image.complete));
                const png = await tab.locator(selector).first().screenshot({ omitBackground: transparent });
                const target = join(outDir, `${scene.name}-${look}.${scene.format === "jpeg" ? "jpg" : "png"}`);
                const image = scene.resize === undefined ? sharp(png) : sharp(png).resize(scene.resize);
                await (
                    scene.format === "jpeg" ? image.jpeg({ quality: 86, mozjpeg: true }) : image.png({ palette: true, quality: 92, effort: 10 })
                ).toFile(target);
                console.log(`  composed ${scene.name} (${look})`);
            }
        }
    } finally {
        await browser.close();
    }
};
