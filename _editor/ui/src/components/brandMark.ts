import { type BrandPalette, brandPalette, officialHex } from "../brandColor.js";

/* FETCHING A BRAND ONCE FOR THE WHOLE APP — the part of <BrandMark> that must not live in its `<script setup>`.
 *
 * A `<script setup>` block's top-level statements compile into the setup FUNCTION, so a `const` cache declared
 * there is per-instance and shares nothing. Measured, not assumed: with the cache inside the component, one
 * screen drawing Docker at three sizes made three requests for the same slug, and the capabilities grid draws 35
 * marks and recycles its rows as the filter narrows. Only imports hoist, so the cache lives in this module — the
 * sibling-module split ImageView, BarChart and ChangeStatusMark already use for the same reason. */

/** What one fetched brand yields: the shape to mask with, and the four colours to paint it in. */
export interface Brand {
    /** A complete CSS `mask-image` value, quoted and ready — see maskValue for why it is built in one piece. */
    readonly mask: string;
    readonly palette: BrandPalette;
}

/* The fetched document as a CSS mask value. QUOTED, and that is the whole reason this is a function rather than
 * an interpolation at the point of use: encodeURIComponent leaves `(`, `)` and `'` alone, and a bare
 * url(data:…) carrying an unescaped paren ends the value early and paints a filled square. Inside double quotes
 * — which encodeURIComponent does escape, so none can appear to close it early — all three are just characters. */
const maskValue = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/* THE AUTHOR'S OWN DRAWING, as something an <img> will load — the top tier, and the only one whose document
 * comes from the manifest rather than from a CDN.
 *
 * Sniffed rather than parsed. What this has to catch is not an attack — the <img> below is what makes the
 * document inert, and it does that whatever the string says — but GARBAGE: a truncated field, a stray URL,
 * somebody's base64 pasted into the wrong key. Handed to an <img>, all of those paint the browser's broken-
 * image glyph, which is the one outcome the ladder exists to prevent. Answering `undefined` instead drops to
 * the tier below, where there is always something real to draw.
 *
 * The `<script` test is not the security boundary and must not be read as one — an SVG in an <img> is loaded in
 * the browser's secure static mode, where script never runs and external references never resolve, and THAT is
 * the guarantee. This is here to say out loud that a mark carrying script is not a mark this app will draw,
 * so a reviewer reading the registry diff knows the answer before they ask. */
export const artSrc = (art: string | undefined): string | undefined => {
    if (art === undefined) {
        return undefined;
    }
    const svg = art.trim();
    /* Opens as markup, carries an <svg> root, and CLOSES it. The closing tag is the load-bearing third of that
     * and the reason this is not a one-line startsWith: the realistic way this field goes wrong is not a
     * hostile document but a truncated one — a string cut short by a length cap, a bad merge, an editor that
     * ate a paste — and `<svg viewBox="0 0 32 32"><rect fill="#6C` opens perfectly well. Requiring the close
     * also rejects a self-closed empty root, which is valid SVG that paints an invisible tile: a hole with a
     * clean bill of health, and the exact outcome the ladder exists to prevent.
     *
     * An XML prolog or a comment ahead of the root is legal and common in exported files, so the opening test
     * is that the document begins as markup — not that its very first byte is the tag itself. */
    if (!svg.startsWith(`<`) || !/<svg[\s>]/iu.test(svg) || !svg.endsWith(`</svg>`) || /<script[\s>]/iu.test(svg)) {
        return undefined;
    }
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

/* Keyed by URL, so the second tile wanting `github` awaits the first one's request instead of opening its own,
 * and a re-render mounts nothing new. The promise is stored BEFORE it settles, which is what makes marks
 * mounting in the same tick share one request rather than race.
 *
 * A slug that fails is cached as a failure too — deliberately. An offline sandbox reaches no CDN, a renamed slug
 * 404s forever, and the caller's slug is not ours to correct; retrying per render would spend the rest of the
 * session asking a question already answered. */
const brands = new Map<string, Promise<Brand | undefined>>();

/** The CDN URL for a simple-icons slug, or undefined for no slug. */
export const brandUrl = (logo: string | undefined): string | undefined =>
    // The slug is taken alone: any `/hex` a manifest pinned is a workaround from when these were painted in the
    // theme's text colour, and honouring it now would override the official colour with a guess at the old bug.
    logo === undefined ? undefined : `https://cdn.simpleicons.org/${logo.split(`/`)[0]}`;

/**
 * The brand behind a CDN url — its official colour resolved into both schemes, and the mark itself as a mask.
 * `undefined` for anything that did not arrive as a coloured mark, which leaves <BrandMark> on its themed tiers.
 */
export const loadBrand = (url: string): Promise<Brand | undefined> => {
    const cached = brands.get(url);
    if (cached !== undefined) {
        return cached;
    }
    // no-referrer because an icon CDN has no business learning which sandbox is looking at it, nor which of its
    // brands that sandbox has installed.
    const pending = fetch(url, { referrerPolicy: `no-referrer` })
        .then(async (response) => {
            if (!response.ok) {
                return undefined;
            }
            const svg = await response.text();
            const hex = officialHex(svg);
            const palette = hex === undefined ? undefined : brandPalette(hex);
            /* The fetched text becomes the mask itself, so the shape costs no second request — and cannot be the
             * one thing that goes missing when a cache header changes. Inert: a mask never runs script, and every
             * colour in the document is discarded anyway, since the fill is read out above and repainted from the
             * palette. A document with no brand colour in it is not a logo tier at all — that is a redirect or an
             * error page served as 200 — so it falls to the glyph rather than being drawn in a colour nobody
             * chose. */
            return palette === undefined ? undefined : { mask: maskValue(svg), palette };
        })
        .catch(() => undefined);
    brands.set(url, pending);
    return pending;
};
