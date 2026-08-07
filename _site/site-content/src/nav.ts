import { compareHref } from "./compare";
import { docsDestinations } from "./docs";
import type { ShotImage } from "./landing";
import { productHref, productPages } from "./product";
import { DEMO_PATH, githubReleasesUrl } from "./site";

/* The site's navigation, as data.
 *
 * Two menus, and both are grouped: a flat list of ten docs pages made "Manifest reference" a peer of
 * "Overview", and the product used to be five anchors into one long page — nothing you could link to, rank,
 * or illustrate. Each row now carries a line of scent, and the product rows carry the screenshot the page
 * opens on, which the mega-menu previews.
 *
 * Compare is a bare LINK, not a third menu. "How does this compare to X?" is the most asked question we get,
 * and the hub's whole answer is that the field sorts into four families before any individual name matters —
 * a menu of six competitor rows would hand a visitor the names without the sorting, which is the part that
 * changes their mind.
 */

export interface MenuItem {
    label: string;
    href: string;
    /** One line under the label: what the page answers. */
    description: string;
    external?: boolean;
    /** Previewed in the panel's rail while this row is hovered. Product rows only. */
    shot?: ShotImage;
}

export interface MenuSection {
    /** Absent for a single-shelf menu, where the rows are the grouping and a header would just repeat the trigger. */
    label?: string;
    items: MenuItem[];
}

export type NavEntry =
    | {
          type: "menu";
          label: string;
          /** Path prefix that marks this menu active. */
          prefix: string;
          sections: MenuSection[];
          /** The one action at the foot of the panel. */
          action?: { label: string; href: string; external?: boolean };
      }
    | { type: "link"; label: string; href: string; prefix: string; external?: boolean };

/* Every feature page as a menu row, in the tree's own order — which already runs "what it is" before "what
 * else it can do", so Doorbell lands last without a header having to say so.
 *
 * ONE COLUMN, no group labels: three headers over 3/3/2 rows was more scaffolding than the eight links under
 * it, and the grouping they carried is what the /product/ index page is for, at a size where a band of cards
 * can actually hold a blurb. What the menu is FOR is the preview rail beside it — a visitor who has installed
 * nothing seeing the real surfaces — and that survives the headers going. */
const productItems = (): MenuItem[] =>
    productPages.map((page) => ({
        label: page.navLabel,
        href: productHref(page.slug),
        description: page.menuBlurb,
        shot: { name: page.hero.name, alt: page.hero.alt },
    }));

export const navEntries: NavEntry[] = [
    {
        /* "Features", not "Product": the site's own copy says free and open source, MIT on GitHub, platform
         * included — and a bar that then says "Product" is reading from a SaaS vendor's script beside it. The
         * URLs stay /product/*, because a label is a word and a URL is a promise other people have already
         * linked to. */
        type: "menu",
        label: "Features",
        prefix: "/product",
        // The extension gallery is NOT a row here: it is already "Extensions" in this same bar, two items to
        // the right, and a menu whose neighbour duplicates it teaches the reader that the bar has no shape.
        sections: [{ items: productItems() }],
        action: { label: "Try the live workspace", href: DEMO_PATH },
    },
    {
        type: "menu",
        label: "Docs",
        prefix: "/docs",
        // One unlabelled column of four destinations — see docsDestinations for why this is not the tree.
        sections: [{ items: [...docsDestinations] }],
        // Release notes as the panel's action rather than a seventh link in the bar. It is the same question
        // the docs answer — what does this thing do — asked about the last two weeks of it, and it was the
        // one row of the bar a visitor reads once a release.
        action: { label: "Release notes", href: githubReleasesUrl, external: true },
    },
    // A bare link, like Compare: the gallery's contents come from the registry repo at build time, so there is
    // no authored list here to build a menu out of.
    {
        type: "link",
        label: "Extensions",
        href: "/extensions/",
        prefix: "/extensions",
    },
    {
        type: "link",
        label: "Compare",
        href: compareHref(""),
        prefix: "/compare",
    },
    // A bare link, and high in the bar on purpose: the download page is an ANSWER to the objection the
    // quickstart raises ("run this command"), so it has to be visible from the page that raises it.
    {
        type: "link",
        label: "Download",
        href: "/download/",
        prefix: "/download",
    },
    // Last of the text links, where a bar conventionally keeps it — and in the bar at all because "who is
    // behind this?" is a question about TRUST, and the reader with it is deciding whether to run a container
    // on their own machine and hand it real credentials. That reader will not go looking in the footer.
    {
        type: "link",
        label: "About",
        href: "/about/",
        prefix: "/about",
    },
];
