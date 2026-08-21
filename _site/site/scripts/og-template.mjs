// @ts-check
// The site's OpenGraph card: brand colours, a section eyebrow, and the page's own title/description.
// Everything AROUND the picture (reading the built page, running satori/resvg, naming the PNG, asserting the
// og:image tag agrees with it) belongs to astro-opengraph-images; this module is only what the card looks like.
//
// The card is a plain satori element tree rather than JSX: satori takes `{ type, props }` directly, so the site
// describes a card without a JSX toolchain it has no other use for.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(), so the fonts are found however the build was invoked.
const REGULAR = fileURLToPath(new URL("./fonts/Inter-Regular.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("./fonts/Inter-Bold.ttf", import.meta.url));

/* The card's ink, taken from global.css: warm near-black, cream, the muted step under it, and ember for the
 * two accents. The FACE stays Inter, and that is a constraint rather than a choice: satori reads ttf/otf/woff
 * and the site's three faces are shipped as woff2 only, which it cannot parse. A card 1200px wide, seen at
 * thumbnail size in a chat client, carries the brand in its colour far more than in its typeface. */
const BG = "#0c0907";
const FG = "#efe3cd";
const MUTED = "#b7a68d";
const ACCENT = "#e07b27";

/**
 * The two Inter faces satori needs, or undefined when they are not on disk. The TTFs are not committed, so a
 * checkout without them still builds: the site falls back to the static logo card (see BaseLayout).
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
 * The line above the title, naming the section the page belongs to. Astro hands the hook a pathname with no
 * leading slash ("docs/quickstart/"), so normalize before matching: prefix tests silently fail otherwise and
 * every card falls through to the site name.
 * @param {string} pathname
 */
function eyebrowFor(pathname) {
    const p = `/${pathname.replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (p.startsWith("/docs")) return "Documentation";
    if (p.startsWith("/product")) return "The product";
    if (p === "/faq") return "FAQ";
    return "intentic";
}

/**
 * One satori element. This is the shape JSX compiles to and what satori consumes, so the card describes itself
 * in it directly. It is deliberately NOT typed as React's `ReactNode` (what the integration's `render` is
 * declared to return): that type demands a `key` satori never looks at, and borrowing it would buy a cast.
 * @typedef {{ type: string, props: { style: Record<string, string | number>, children: string | OgNode[] } }} OgNode
 */

/**
 * @param {Record<string, string | number>} style
 * @param {string | OgNode[]} children
 * @returns {OgNode}
 */
const box = (style, children) => ({ type: "div", props: { style, children } });

/**
 * @param {{ pathname: string, title: string, description?: string }} page
 * @returns {OgNode}
 */
export function ogCard({ pathname, title, description }) {
    return box(
        {
            width: 1200,
            height: 628,
            display: "flex",
            flexDirection: "column",
            background: BG,
            padding: 80,
            color: FG,
            fontFamily: "Inter",
        },
        [
            box({ fontSize: 24, color: ACCENT, letterSpacing: 4, textTransform: "uppercase", fontWeight: 600 }, eyebrowFor(pathname)),
            box({ fontSize: 64, fontWeight: 700, marginTop: 32, lineHeight: 1.15, maxWidth: 1040 }, title),
            // A page whose description repeats its title arrives here without one: drop the block rather than
            // rendering the same sentence twice at two sizes.
            ...(description === undefined ? [] : [box({ fontSize: 26, color: MUTED, marginTop: 32, lineHeight: 1.4, maxWidth: 1040 }, description)]),
            box({ marginTop: "auto", fontSize: 24, color: ACCENT, fontWeight: 600 }, "intentic.dev"),
        ],
    );
}
