import { z } from "zod";

/* HOW SOMETHING LOOKS BEFORE ANY OF ITS CODE RUNS — the mark a capability card and an extension are drawn
 * with, in ONE shape because one component draws both (<BrandMark>) and a second copy of these two fields is a
 * second answer to what happens when a slug 404s.
 *
 * Two tiers, and neither is required. `logo` is a simple-icons slug fetched from a CDN: exactly right for a
 * card standing in for somebody else's product (GitHub, Postgres, Slack), useless for the many things that
 * have no brand in that set, and unreachable in an offline sandbox — so it can never be the only tier. `icon`
 * is a name from the host's own bundled vocabulary, which ships in the image, follows the theme and costs no
 * request; it is what actually carries a first-party extension. What declares neither is drawn as its
 * initials, so no row is ever blank and no author is obliged to have a brand.
 *
 * A slug that fails to load and an icon name this build has never heard of both fall to the tier BELOW rather
 * than to a hole — the rule the rail already applies to Activation.icon, here for the surfaces that must draw
 * an extension whose code is not running: one that is switched off, one that is daemon-only, one being read
 * about in a registry before it is installed at all. */
export const MARK_FIELDS = {
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
