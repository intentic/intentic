// @ts-check
// The card's look; everything around the picture -- reading the page, running satori/resvg, naming and asserting the
// PNG -- belongs to astro-opengraph-images. A plain satori element tree, `{ type, props }`, not JSX: no toolchain
// needed for one file.
//
// The card wears the site's LIGHT skin, not the dark one the site defaults to. A social feed and a directory listing
// are both mostly white, and a near-black card reads there as a hole rather than a product. The colours below are the
// maker palette's oklch tokens resolved to sRGB (scripts/check-maker-palette.mjs owns the tokens themselves).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(), so the assets are found however the build was invoked.
const REGULAR = fileURLToPath(new URL("./fonts/Inter-Regular.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("./fonts/Inter-Bold.ttf", import.meta.url));
const BOARD = fileURLToPath(new URL("./og/board-light.png", import.meta.url));
const MARK = fileURLToPath(new URL("./og/mark.png", import.meta.url));

// The maker skin, resolved. `CANVAS` is the same value BaseLayout ships as the light `theme-color`.
const CANVAS = "#f5ede7";
const LINE = "#e9dfd8";
const INK = "#29201a";
const MUTED = "#62564e";
const GOLD = "#84390d";

// The board shot is 1500x560; drawn at this width it lands on 1072x400, and the window crops the last 60px so the
// picture runs off the bottom edge instead of stopping short of it.
const SHOT_W = 1072;
const SHOT_H = 400;
const WINDOW_H = 340;

/**
 * The two Inter faces satori needs, or undefined if the TTFs aren't on disk (an uncommitted checkout still builds;
 * BaseLayout falls back to the static logo).
 * @returns {import("astro-opengraph-images").SatoriFontOptions[] | undefined}
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
const LANDING = new Set(["", "maker"]);

/**
 * One satori element. This is the shape JSX compiles to and what satori consumes, so the card describes itself
 * in it directly. It is deliberately NOT typed as React's `ReactNode` (what the integration's `render` is
 * declared to return): that type demands a `key` satori never looks at, and borrowing it would buy a cast.
 * @typedef {{ type: string, props: Record<string, unknown> }} OgNode
 */

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
 * @param {{ pathname: string, title: string, description?: string }} page
 * @returns {OgNode}
 */
export function ogCard({ pathname, title, description }) {
    const landing = LANDING.has(routeOf(pathname));
    // The platform renders the page title as the link's own heading, directly under this picture. Repeating it here
    // spends the card's only headline on a sentence the reader is already being shown, so the landing card says the
    // one thing nothing else on the post says.
    const headline = landing ? "More work. Less AI waste. Same subscriptions." : title;
    const sub = landing ? "A workspace for coding agents." : description;
    const board = dataUri(BOARD);
    const mark = dataUri(MARK);

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
            // rather than pushing it off the card.
            ...(board === undefined
                ? []
                : [
                      box(
                          {
                              display: "flex",
                              marginTop: "auto",
                              width: SHOT_W,
                              height: WINDOW_H,
                              borderRadius: "14px 14px 0 0",
                              border: `1px solid ${LINE}`,
                              borderBottom: "none",
                              overflow: "hidden",
                              boxShadow: "0 4px 10px rgba(61, 40, 22, 0.08), 0 24px 56px -12px rgba(61, 40, 22, 0.26)",
                          },
                          [img(board, { width: SHOT_W, height: SHOT_H })],
                      ),
                  ]),
        ],
    );
}
