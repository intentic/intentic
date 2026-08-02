import { compareHref } from "./compare";
import { docsHref, docsSections } from "./docs";
import type { ShotImage } from "./landing";
import type { ProductPage } from "./product";
import { productHref, productPages } from "./product";
import { DEMO_PATH } from "./site";

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
    label: string;
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

const productItems = (group: ProductPage["group"]): MenuItem[] =>
    productPages
        .filter((page) => page.group === group)
        .map((page) => ({
            label: page.navLabel,
            href: productHref(page.slug),
            description: page.menuBlurb,
            shot: { src: page.hero.src, alt: page.hero.alt, width: page.hero.width, height: page.hero.height },
        }));

export const navEntries: NavEntry[] = [
    {
        type: "menu",
        label: "Product",
        prefix: "/product",
        sections: [
            { label: "Run agents", items: productItems("run") },
            { label: "The environment", items: productItems("environment") },
            // The third column is the nav's version of the landing page's "Extend it" band: the surfaces
            // that answer "what else can it do" sit apart from the ones that answer "what is it". Doorbell
            // used to head the "Run agents" column, which read as a claim that a website chat widget is
            // what this product is for.
            {
                label: "Extend it",
                items: [
                    ...productItems("extend"),
                    { label: "Extension gallery", href: "/extensions/", description: "Everything published, and the commit you'd install" },
                ],
            },
        ],
        action: { label: "Try the live workspace", href: DEMO_PATH },
    },
    {
        type: "menu",
        label: "Docs",
        prefix: "/docs",
        sections: docsSections.map((section) => ({
            label: section.label,
            items: section.items.map((page) => ({ label: page.title, href: docsHref(page.id), description: page.blurb })),
        })),
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
    {
        type: "link",
        label: "Release notes",
        href: "https://gitlab.com/radarsu/intentic/-/releases",
        prefix: "/release-notes",
        external: true,
    },
];
