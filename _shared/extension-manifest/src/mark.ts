import { z } from "zod";

// The mark a capability card or extension draws itself with, one shape since one component (<BrandMark>) draws both:
// `art` (inline SVG, own drawing) beats `logo` (simple-icons slug) beats `icon` (host's set), falling back to initials
// when none is declared.

// Big enough for a drawn mark, far too small for a traced photograph.
const ART_MAX_BYTES = 4096;

export const MARK_FIELDS = {
    // SVG document itself, not a URL or base64; drawn inert (<img>, never inlined) so a row can't script the page.
    art: z
        .string()
        .max(ART_MAX_BYTES)
        .optional()
        .describe(
            "This extension's own mark, as a complete SVG document inline: the tier an author controls fully. Give it a viewBox and let it fill its own square edge to edge; it is drawn as the tile, not as a glyph on a plate. Kept as readable SVG text (not base64) so a registry reviewer can see what they are publishing, drawn inert so it cannot script the page, and capped at 4 KB. Anything that does not parse as SVG falls back to `logo`, then `icon`, then initials.",
        ),
    // A simple-icons slug (https://cdn.simpleicons.org/<slug>). A "/<hex>" suffix forces a colour for a mark that
    // vanishes against its surface.
    logo: z
        .string()
        .optional()
        .describe(
            'A simple-icons slug, fetched from a CDN: right for standing in for somebody else\'s product. Add a "/<hex>" suffix to force a colour for a mark that vanishes against the surface it lands on. Unreachable in an offline sandbox, so it falls back to `icon`, then to initials.',
        ),
    // A name from the host's own icon set (@intentic/ui IconName), drawn when no simple-icons slug fits.
    icon: z
        .string()
        .optional()
        .describe(
            "A name from the host's own icon set, drawn when no simple-icons slug fits. It ships in the image, follows the theme and costs no request: what actually carries a first-party extension. An unknown name falls back to initials rather than to a hole.",
        ),
};
