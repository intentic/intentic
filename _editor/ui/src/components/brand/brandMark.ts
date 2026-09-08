import { type BrandPalette, brandPalette, officialHex } from "../../lib/brandColor.js";

// Caches fetched brands at module scope, not inside <BrandMark>'s `<script setup>` (whose top-level `const`s are
// per-instance and share nothing). Same sibling-module split as ImageView, BarChart and ChangeStatusMark.

/** What one fetched brand yields: the shape to mask with, and the four colours to paint it in. */
export interface Brand {
    /** A complete CSS `mask-image` value, quoted and ready to use. */
    readonly mask: string;
    readonly palette: BrandPalette;
}

// Quoted, not interpolated bare: encodeURIComponent leaves `(`, `)` and `'` unescaped, and an unescaped paren in a
// bare `url(data:…)` ends the value early and paints a filled square.
const maskValue = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

// Sniffs rather than parses: catches garbage (truncated fields, wrong pastes), not attacks — the `<img>` sink is
// what makes any script inert regardless. Returns undefined to drop to the tier below.
export const artSrc = (art: string | undefined): string | undefined => {
    if (art === undefined) {
        return undefined;
    }
    const svg = art.trim();
    // Requires the closing `</svg>` tag, to catch truncated input and reject a self-closed empty (but valid) root.
    if (!svg.startsWith(`<`) || !/<svg[\s>]/iu.test(svg) || !svg.endsWith(`</svg>`) || /<script[\s>]/iu.test(svg)) {
        return undefined;
    }
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

// Keyed by URL, so concurrent requests share one promise; failures cache too, since retrying won't fix a 404.
const brands = new Map<string, Promise<Brand | undefined>>();

/** The CDN URL for a simple-icons slug, or undefined for no slug. */
export const brandUrl = (logo: string | undefined): string | undefined =>
    // Slug only: a `/hex` some manifests pinned was an old workaround that would override the real brand colour.
    logo === undefined ? undefined : `https://cdn.simpleicons.org/${logo.split(`/`)[0]}`;

/**
 * The brand behind a CDN url: its official colour in both schemes, and the mark as a mask. Undefined leaves
 * <BrandMark> on its themed tiers.
 */
export const loadBrand = (url: string): Promise<Brand | undefined> => {
    const cached = brands.get(url);
    if (cached !== undefined) {
        return cached;
    }
    // no-referrer: an icon CDN shouldn't learn which sandbox is looking, or which of its brands it has installed.
    const pending = fetch(url, { referrerPolicy: `no-referrer` })
        .then(async (response) => {
            if (!response.ok) {
                return undefined;
            }
            const svg = await response.text();
            const hex = officialHex(svg);
            const palette = hex === undefined ? undefined : brandPalette(hex);
            // Mask is built from the same fetched text, so the shape costs no second request. No colour in the document
            // (a
            // redirect or error page served as 200) means no logo tier at all — falls to the glyph instead.
            return palette === undefined ? undefined : { mask: maskValue(svg), palette };
        })
        .catch(() => undefined);
    brands.set(url, pending);
    return pending;
};
