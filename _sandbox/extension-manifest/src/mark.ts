import { z } from "zod";

/* HOW SOMETHING LOOKS BEFORE ANY OF ITS CODE RUNS, the mark a capability card and an extension are drawn
 * with, in ONE shape because one component draws both (<BrandMark>) and a second copy of these two fields is a
 * second answer to what happens when a slug 404s.
 *
 * Three tiers, and none is required. `art` is the extension's OWN drawing, carried inline: the only tier an
 * author controls completely, and the only one that can make a grid of unfamiliar names look like a shelf of
 * distinct products rather than a column of identical glyphs. `logo` is a simple-icons slug fetched from a
 * CDN: exactly right for a card standing in for somebody else's product (GitHub, Postgres, Slack), useless
 * for the many things that have no brand in that set, and unreachable in an offline sandbox, so it can never
 * be the only tier. `icon` is a name from the host's own bundled vocabulary, which ships in the image, follows
 * the theme and costs no request; it is what carries a first-party extension that has not been drawn yet. What
 * declares none of them is drawn as its initials, so no row is ever blank and no author is obliged to have a
 * brand or an illustrator.
 *
 * ART BEATS A BRAND SLUG because they answer different questions. A slug says "this is Slack"; art says "this
 * is mine". An extension that stands in for somebody else's product should declare the slug and no art, and
 * one that is its own thing should declare art, but where both arrive, the author's own drawing is the more
 * specific claim and wins.
 *
 * Artwork that will not parse, a slug that fails to load and an icon name this build has never heard of all
 * fall to the tier BELOW rather than to a hole, the rule the rail already applies to Activation.icon, here for
 * the surfaces that must draw an extension whose code is not running: one that is switched off, one that is
 * daemon-only, one being read about in a registry before it is installed at all. */

/* Big enough for a drawn mark, far too small for a traced photograph, which is the line being drawn. This
 * string rides every registry row and every manifest read, so it is a budget as much as a limit: at 4 KB the
 * whole official registry's artwork costs less than one screenshot, and an author who needs more than that is
 * shipping a raster they should be shipping as a brand slug or not at all. */
const ART_MAX_BYTES = 4096;

export const MARK_FIELDS = {
    /* THE SVG DOCUMENT ITSELF, not a URL and not base64.
     *
     * A URL would put a stranger's server in the render path of a page listing extensions, a fetch that
     * tracks who is browsing what, breaks in an offline sandbox, and 404s long after the row was approved:
     * the three failures the `logo` tier already documents, with none of its excuse. Inline costs one string
     * and always draws.
     *
     * Kept as READABLE TEXT rather than a data URI because of who reads it. The registry's curated file is
     * reviewed by a human before anything is published, and `<rect fill="#5B4FE9"/><circle .../>` can be read
     * in a diff, while base64 is a wall nobody checks, an opaque blob in the one file whose entire purpose is
     * to be checked. The renderer does its own encoding at the point of use.
     *
     * It is drawn INERT (an <img>, never inline in the document), so a hostile registry row cannot script the
     * page it is listed on, see <BrandMark>, which owns that guarantee and the sniff test that enforces it. */
    art: z
        .string()
        .max(ART_MAX_BYTES)
        .optional()
        .describe(
            "This extension's own mark, as a complete SVG document inline — the tier an author controls fully. Give it a viewBox and let it fill its own square edge to edge; it is drawn as the tile, not as a glyph on a plate. Kept as readable SVG text (not base64) so a registry reviewer can see what they are publishing, drawn inert so it cannot script the page, and capped at 4 KB. Anything that does not parse as SVG falls back to `logo`, then `icon`, then initials.",
        ),
    // A simple-icons slug (https://cdn.simpleicons.org/<slug>). A "/<hex>" suffix forces a colour for marks
    // that vanish against the surface they land on (github's near-black).
    logo: z
        .string()
        .optional()
        .describe(
            'A simple-icons slug, fetched from a CDN — right for standing in for somebody else\'s product. Add a "/<hex>" suffix to force a colour for a mark that vanishes against the surface it lands on. Unreachable in an offline sandbox, so it falls back to `icon`, then to initials.',
        ),
    // A name from the host's icon set (@intentic/ui IconName), drawn when no simple-icons slug fits.
    icon: z
        .string()
        .optional()
        .describe(
            "A name from the host's own icon set, drawn when no simple-icons slug fits. It ships in the image, follows the theme and costs no request — what actually carries a first-party extension. An unknown name falls back to initials rather than to a hole.",
        ),
};
