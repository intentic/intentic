import { comparePages, compareHref } from "./compare";
import { developersDestinations } from "./developers";
import { docsDestinations, docsHref } from "./docs";
import { guidePages, guidesHref } from "./guides";
import type { ShotImage } from "./landing";
import { productHref, productPages } from "./product";
import { referenceDestinations, referenceHref } from "./reference";
import { DEMO_PATH, discordUrl } from "./site";

// Site navigation as data: one source for the bar, phone overlay and footer menus. The bar holds only the buyer's path
// (Features, Docs, Resources, Pricing, About); everything for a builder lives in Developers. Compare is a Resources
// row, not a tab; Download is deliberately omitted, since the app is not a separate way in.

export interface MenuItem {
    label: string;
    href: string;
    /** One short line under the label: what the page answers. Omitted for a menu that shows labels alone. */
    description?: string;
    /** Icon key drawn to the left of the label, resolved by the site's `navIcons`. */
    icon?: string;
    /** Every page this row stands for, marked current from any of them, not just its href (book rows only). */
    covers?: string[];
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
          /** Every path prefix this label is current for: Resources spans /guides, /blog, /compare, /changelog. */
          prefixes: string[];
          sections: MenuSection[];
          /** The one action at the foot of the panel. */
          action?: { label: string; href: string; external?: boolean };
      }
    | { type: "link"; label: string; href: string; prefix: string; external?: boolean };

// Feature pages as menu rows, one column, no group labels; each label is its page's slug. Every row carries a shot
// (even Automate's diagram), so the preview rail never falls back to the row above's picture.
const productItems = (): MenuItem[] =>
    productPages.map((page) => {
        // Falls back to the page hero when there's no menuShot; a hero fits a page column, not the rail's 16:10 box.
        const shot = page.menuShot ?? (page.hero && { name: page.hero.name, alt: page.hero.alt });
        return {
            label: page.navLabel,
            href: productHref(page.slug),
            description: page.menuBlurb,
            icon: page.icon,
            ...(shot ? { shot } : {}),
        };
    });

export const navEntries: NavEntry[] = [
    {
        // Named "Features", not "Product": the copy is open source, not a vendor's script. Label and path now agree.
        type: "menu",
        label: "Features",
        prefixes: ["/features"],
        // Extension gallery is a Developers row, not here; no destination sits in two neighbouring menus.
        sections: [{ items: productItems() }],
        action: { label: "Try the demo workspace", href: DEMO_PATH },
    },
    {
        type: "menu",
        label: "Docs",
        prefixes: ["/docs"],
        // One unlabelled column of four destinations (not the full docs tree).
        sections: [{ items: [...docsDestinations] }],
        // Changelog is a Resources row now; a destination shouldn't sit in two neighbouring menus.
        action: { label: "Troubleshooting", href: docsHref("troubleshooting") },
    },
    // Resources, ordered as read: guides, blog/compare, changelog, community. No `covers` on blog (markdown).
    {
        type: "menu",
        label: "Resources",
        prefixes: ["/guides", "/blog", "/compare", "/changelog"],
        sections: [
            {
                items: [
                    {
                        label: "Guides",
                        href: guidesHref(""),
                        description: "Asked before you find us",
                        icon: "compass",
                        covers: [guidesHref(""), ...guidePages.map((page) => guidesHref(page.slug))],
                    },
                    {
                        label: "Blog",
                        href: "/blog/",
                        description: "What we worked out, and got wrong",
                        icon: "newspaper",
                    },
                    {
                        label: "Compare",
                        href: compareHref(""),
                        description: "Cursor, Claude Code, Conductor, cloud agents",
                        icon: "git-compare",
                        covers: [compareHref(""), ...comparePages.map((page) => compareHref(page.slug))],
                    },
                    {
                        label: "Changelog",
                        href: "/changelog/",
                        description: "What shipped, in plain words",
                        icon: "history",
                    },
                    {
                        label: "Community",
                        href: discordUrl,
                        description: "Ask in Discord",
                        icon: "message-circle",
                        external: true,
                    },
                ],
            },
        ],
        action: { label: "The blog by RSS", href: "/blog/rss.xml", external: true },
    },
    // Everything for someone building on intentic; API and gallery are one row each, with their own rail on /api/.
    {
        type: "menu",
        label: "Developers",
        prefixes: ["/developers", "/api", "/extensions"],
        sections: [
            {
                items: [
                    ...developersDestinations,
                    {
                        label: "Sandbox API",
                        href: referenceHref(""),
                        description: "Every call a sandbox answers",
                        icon: "network",
                        covers: referenceDestinations.flatMap((destination) => destination.covers ?? [destination.href]),
                    },
                    {
                        label: "Extensions gallery",
                        href: "/extensions/",
                        description: "What people have published",
                        icon: "blocks",
                    },
                ],
            },
        ],
        action: { label: "Download the OpenAPI document", href: `${referenceHref("")}openapi.json` },
    },
    // Highest-intent click on a dev-tool site; a visitor who finds no pricing link assumes it's hidden.
    {
        type: "link",
        label: "Pricing",
        href: "/pricing/",
        prefix: "/pricing",
    },
    // In the bar, not just the footer: trust matters before running a container with real credentials.
    {
        type: "link",
        label: "About",
        href: "/about/",
        prefix: "/about",
    },
];
