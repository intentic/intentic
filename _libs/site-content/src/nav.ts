import { compareHref } from "./compare";
import { docsHref, docsSections } from "./docs";
import type { ShotImage } from "./landing";
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

const productItems = (group: "run" | "environment"): MenuItem[] =>
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
            { label: "Configure the environment", items: productItems("environment") },
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
    {
        type: "link",
        label: "Compare",
        href: compareHref(""),
        prefix: "/compare",
    },
    {
        type: "link",
        label: "Release notes",
        href: "https://gitlab.com/radarsu/intentic/-/releases",
        prefix: "/release-notes",
        external: true,
    },
];
