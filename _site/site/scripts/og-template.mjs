// @ts-check
// The card's look; everything around the picture -- reading the page, running satori/resvg, naming and asserting the
// PNG -- belongs to `ogImages` in @intentic/astro-integrations. A plain satori element tree, `{ type, props }`, not JSX:
// no toolchain needed for one file.
//
// The card wears the site's LIGHT skin, not the dark one the site defaults to. A social feed and a directory listing
// are both mostly white, and a near-black card reads there as a hole rather than a product. The colours below are the
// desk palette's oklch tokens resolved to sRGB (scripts/check-desk-palette.mjs owns the tokens themselves).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(), so the assets are found however the build was invoked.
const REGULAR = fileURLToPath(new URL("./fonts/Inter-Regular.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("./fonts/Inter-Bold.ttf", import.meta.url));
const BOARD = fileURLToPath(new URL("./og/board-light.png", import.meta.url));
const MARK = fileURLToPath(new URL("./og/mark.png", import.meta.url));

// The desk skin, resolved. `CANVAS` is the same value BaseLayout ships as the light `theme-color`.
const CANVAS = "#f5ede7";
const LINE = "#e9dfd8";
const INK = "#29201a";
const MUTED = "#62564e";
const GOLD = "#84390d";

// The board shot is 1500x560, the top of the light `stage-run` capture scaled down; re-cut it when that shot changes:
//   magick src/assets/product-light/stage-run.png -crop 2880x1075+0+0 +repage -resize '1500x560!' scripts/og/board-light.png
// Drawn at this width it lands on 1072x400, and the window crops the last 60px so the
// picture runs off the bottom edge instead of stopping short of it.
const SHOT_W = 1072;
const SHOT_H = 400;
const WINDOW_H = 340;

// The window's drop shadow, and how far past the window's edges the baked layer reaches (`windowShadow`). The deep
// shadow's 56px blur fades out about 84px from the edge it is cast from; 128 keeps the whole of it.
const WINDOW_SHADOW = "0 4px 10px rgba(61, 40, 22, 0.08), 0 24px 56px -12px rgba(61, 40, 22, 0.26)";
const SHADOW_BLEED = 128;

/**
 * @typedef {import("@intentic/astro-integrations/og-images").OgNode} OgNode
 * @typedef {import("@intentic/astro-integrations/og-images").OgPage} OgPage
 * @typedef {import("@intentic/astro-integrations/og-images").OgTools} OgTools
 */

/**
 * The two Inter faces satori needs, or undefined if the TTFs aren't on disk (an uncommitted checkout still builds;
 * BaseLayout falls back to the static logo).
 * @returns {import("@intentic/astro-integrations/og-images").OgFont[] | undefined}
 */
export function ogFonts() {
    if (!existsSync(REGULAR) || !existsSync(BOLD)) {
        return undefined;
    }
    return [
        { name: "Inter", data: readFileSync(REGULAR), weight: 400, style: "normal" },
        { name: "Inter", data: readFileSync(BOLD), weight: 700, style: "normal" },
    ];
}

/**
 * satori takes an `<img>` src as a data URI or a URL, and a build has no server to fetch from, so every picture on the
 * card is inlined. Returns undefined for a missing file: the card then renders without that element rather than
 * failing the build.
 * @param {string} file
 */
function dataUri(file) {
    return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString("base64")}` : undefined;
}

// Read once per build, not once per card: every card carries the same two pictures.
/** @type {{ board: string | undefined, mark: string | undefined } | undefined} */
let pictures;

/**
 * The route, with nothing around it: no leading slash, no trailing slash, no `index.html`. Astro hands the hook a
 * pathname with no leading slash and a trailing one, but the landing page is the row that matters and its spelling is
 * the one a build could change under us, so every caller goes through here rather than matching the raw string.
 * Returns "" for the landing page.
 * @param {string} pathname
 */
function routeOf(pathname) {
    return pathname
        .replace(/^\/+/, "")
        .replace(/index\.html?$/, "")
        .replace(/\/+$/, "");
}

/**
 * The line at the top right, naming the page's section.
 * @param {string} pathname
 */
function eyebrowFor(pathname) {
    const p = `/${routeOf(pathname)}`;
    if (p.startsWith("/docs")) {
        return "Documentation";
    }
    if (p.startsWith("/api")) {
        return "API";
    }
    if (p.startsWith("/product") || p.startsWith("/features")) {
        return "The product";
    }
    if (p.startsWith("/compare")) {
        return "Compare";
    }
    if (p.startsWith("/guides")) {
        return "Guides";
    }
    if (p === "/faq") {
        return "FAQ";
    }
    return "intentic.dev";
}

/** The two routes that render the landing page. Both get the brand line instead of the page title; see `ogCard`. */
const LANDING = new Set(["", "desk"]);

/**
 * @param {Record<string, string | number>} style
 * @param {string | OgNode[]} children
 * @returns {OgNode}
 */
const box = (style, children) => ({ type: "div", props: { style, children } });

/**
 * @param {string} src
 * @param {Record<string, string | number>} style
 * @returns {OgNode}
 */
const img = (src, style) => ({ type: "img", props: { src, style } });

/**
 * Three sizes, picked off the title's length. satori cannot measure text for us, so the alternative to a ladder is a
 * headline that silently overruns the card on the longest page titles.
 * @param {string} title
 */
function headlineSize(title) {
    if (title.length <= 34) {
        return 58;
    }
    return title.length <= 58 ? 48 : 40;
}

/**
 * The window's drop shadow alone, on a transparent sheet reaching SHADOW_BLEED past the window on every side.
 *
 * Drawn once per build and laid under each card's window as a picture, because resvg spent ~620 of the ~690 ms a card
 * took blurring this shadow: satori sizes a blur's filter region at several times the box it shadows, so the deep
 * shadow was a 56px blur over ~5 megapixels, redone for every page. The layer is the same satori shadow on the same box,
 * so a card differs from one that blurs its own only by rounding in the soft edge (at most 6 of 255 on one channel).
 * @param {OgTools} tools
 */
function windowShadow({ rasterize }) {
    const width = SHOT_W + 2 * SHADOW_BLEED;
    const height = WINDOW_H + 2 * SHADOW_BLEED;
    const sheet = box({ display: "flex", width, height, padding: SHADOW_BLEED }, [
        box({ display: "flex", width: SHOT_W, height: WINDOW_H, borderRadius: "14px 14px 0 0", boxShadow: WINDOW_SHADOW }, []),
    ]);
    return rasterize(sheet, { width, height }).then((png) => `data:image/png;base64,${png.toString("base64")}`);
}

/** @type {Promise<string> | undefined} */
let shadow;

/**
 * @param {OgPage} page
 * @param {OgTools} tools
 * @returns {Promise<OgNode>}
 */
export async function ogCard({ pathname, title, description }, tools) {
    const landing = LANDING.has(routeOf(pathname));
    // The platform renders the page title as the link's own heading, directly under this picture. Repeating it here
    // spends the card's only headline on a sentence the reader is already being shown, so the landing card says the
    // one thing nothing else on the post says.
    const headline = landing ? "More work. Less AI waste. Same subscriptions." : title;
    const sub = landing ? "A workspace for coding agents." : description;
    pictures ??= { board: dataUri(BOARD), mark: dataUri(MARK) };
    const { board, mark } = pictures;
    const windowShadowLayer = board === undefined ? undefined : await (shadow ??= windowShadow(tools));

    return box(
        {
            width: 1200,
            height: 628,
            display: "flex",
            flexDirection: "column",
            background: CANVAS,
            padding: "56px 64px 0 64px",
            color: INK,
            fontFamily: "Inter",
            overflow: "hidden",
        },
        [
            box({ display: "flex", alignItems: "center", width: "100%" }, [
                ...(mark === undefined ? [] : [img(mark, { width: 40, height: 40, borderRadius: 10, marginRight: 14 })]),
                box({ fontSize: 30, fontWeight: 700, letterSpacing: -0.4 }, "intentic"),
                box(
                    { marginLeft: "auto", fontSize: 19, color: GOLD, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase" },
                    eyebrowFor(pathname),
                ),
            ]),
            box({ fontSize: headlineSize(headline), fontWeight: 700, marginTop: 34, lineHeight: 1.12, letterSpacing: -1, maxWidth: 980 }, headline),
            // A page whose description repeats its title arrives without one; drop the block, don't repeat the sentence.
            ...(sub === undefined ? [] : [box({ fontSize: 24, color: MUTED, marginTop: 18, lineHeight: 1.35, maxWidth: 880 }, sub)]),
            // `marginTop: auto` pins the window to the bottom, so a three-line title eats the gap above the picture
            // rather than pushing it off the card. The shadow layer comes first so the window is drawn over it, as
            // a box is drawn over its own shadow.
            ...(board === undefined || windowShadowLayer === undefined
                ? []
                : [
                      box({ display: "flex", position: "relative", marginTop: "auto", width: SHOT_W, height: WINDOW_H }, [
                          img(windowShadowLayer, {
                              position: "absolute",
                              left: -SHADOW_BLEED,
                              top: -SHADOW_BLEED,
                              width: SHOT_W + 2 * SHADOW_BLEED,
                              height: WINDOW_H + 2 * SHADOW_BLEED,
                          }),
                          box(
                              {
                                  display: "flex",
                                  width: SHOT_W,
                                  height: WINDOW_H,
                                  borderRadius: "14px 14px 0 0",
                                  border: `1px solid ${LINE}`,
                                  borderBottom: "none",
                                  overflow: "hidden",
                              },
                              [img(board, { width: SHOT_W, height: SHOT_H })],
                          ),
                      ]),
                  ]),
        ],
    );
}
