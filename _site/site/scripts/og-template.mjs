// @ts-check
// The card's look (brand colours, eyebrow, title/description); everything around the picture -- reading the page,
// running satori/resvg, naming and asserting the PNG -- belongs to astro-opengraph-images. A plain satori element tree,
// `{ type, props }`, not JSX: no toolchain needed for one file.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(), so the fonts are found however the build was invoked.
const REGULAR = fileURLToPath(new URL("./fonts/Inter-Regular.ttf", import.meta.url));
const BOLD = fileURLToPath(new URL("./fonts/Inter-Bold.ttf", import.meta.url));

// Colours match global.css; Inter is forced, since satori can't parse woff2, the site's other faces' format.
const BG = "#0c0907";
const FG = "#efe3cd";
const MUTED = "#b7a68d";
const ACCENT = "#e07b27";

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
 * The line above the title, naming the page's section. Astro hands the hook a pathname with no leading slash; normalize
 * before matching or prefix tests silently fail.
 * @param {string} pathname
 */
function eyebrowFor(pathname) {
    const p = `/${pathname.replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (p.startsWith("/docs")) {
        return "Documentation";
    }
    if (p.startsWith("/product")) {
        return "The product";
    }
    if (p === "/faq") {
        return "FAQ";
    }
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
            // A page whose description repeats its title arrives without one; drop the block, don't repeat the
            // sentence.
            ...(description === undefined ? [] : [box({ fontSize: 26, color: MUTED, marginTop: 32, lineHeight: 1.4, maxWidth: 1040 }, description)]),
            box({ marginTop: "auto", fontSize: 24, color: ACCENT, fontWeight: 600 }, "intentic.dev"),
        ],
    );
}
