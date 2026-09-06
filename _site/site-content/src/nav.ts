import { comparePages, compareHref } from "./compare";
import { developersDestinations, developersServicesDestination } from "./developers";
import { docsDestinations, docsHref } from "./docs";
import { guidePages, guidesHref } from "./guides";
import type { ShotImage } from "./landing";
import { productHref, productPages } from "./product";
import { referenceDestinations, referenceHref } from "./reference";
import { DEMO_PATH, discordUrl } from "./site";

/* The site's navigation, as data. One source for the bar, the phone overlay and the footer's menus.
 *
 * The bar is spent on the buyer's path (Features, Docs, Resources, Pricing, About); every builder destination
 * lives in one Developers menu. It used to run seven labels, four of them for somebody extending the product,
 * while the guides, the blog and the comparisons had no bar presence at all (docs/site-audit-2026-09.md).
 *
 * Compare is a row inside Resources, not a tab: a tab would introduce a field of rivals before the doubt
 * exists, a row is read only by someone who opened the menu looking for this kind of page.
 *
 * Download is the deliberate omission. The app is not a way INTO the product: both roads end at the same
 * signed-in workspace, and what it replaces is one step, the terminal command that puts a sandbox on your
 * machine. A permanent tab beside "Create your workspace" offers two openings where there is one, and most
 * of the people who take it are first-timers clicking the most concrete-sounding word in the bar: a longer
 * road to the same place, a binary to install before they know what it is for, and on a Mac no build at all.
 * It lives where the need is instead: the Resources column of the footer, and the band of the home page that
 * asks for a terminal, beside the command.
 */

export interface MenuItem {
    label: string;
    href: string;
    /** One short line under the label: what the page answers. Omitted for a menu that shows labels alone. */
    description?: string;
    /** Icon key drawn to the left of the label, resolved by the site's `navIcons`. */
    icon?: string;
    /**
     * Every page this row stands for, so the surfaces that draw it can mark it while the reader is on any of
     * them — not only on the one page its href happens to point at. Carried by the rows derived from a book,
     * where a row is a SHELF (see `bookDestinations`); absent on rows that are simply one page.
     */
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

/* Every feature page as a menu row, in the shelf's own order: five verbs (Run, Connect, Automate, Review,
 * Host) rather than a list of surfaces, so the menu reads as what you DO with a fleet, not the furniture any
 * editor has. Each row's label is its page's slug, so the word in the menu is the word in the address bar.
 *
 * ONE COLUMN, no group labels: a verb is its own grouping, so the run/environment/extend headers that once
 * sorted seven surfaces would be more scaffolding than the rows under them. What the menu is FOR is the
 * preview rail beside it: a visitor who has installed nothing seeing the real surfaces. EVERY row carries a
 * shot, including the diagram-led one: a row without a picture does not blank the rail, it leaves the row
 * above still showing, which is how Automate spent a while illustrated by the capabilities catalog. */
const productItems = (): MenuItem[] =>
    productPages.map((page) => {
        /* The row's own preview where it has one, the page hero otherwise. A hero is framed for a page column
         * and the rail is a 16:10 box, so three of the five pages carry a capture shot for the box instead,
         * see `menuShot` in product.ts for which, and why the other two don't need one. */
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
        /* "Features", not "Product": the site's own copy says free and open source, MIT on GitHub, platform
         * included, and a bar that then says "Product" is reading from a SaaS vendor's script beside it.
         *
         * AND THE PATH SAYS IT TOO. The label and the URL used to disagree, "Features" over /product/, "Run"
         * over /product/orchestrate/, on the theory that a label is a word while a URL is a promise already
         * linked to. That gets the trade backwards: a URL is also read, and a visitor who clicks Run and lands
         * on "orchestrate" has been handed a second vocabulary to learn for no benefit. The old paths are
         * forwarded (see worker.ts), so the links other people made still arrive. */
        type: "menu",
        label: "Features",
        prefixes: ["/features"],
        // The extension gallery is NOT a row here: it is a row of the Developers menu, which is where the
        // rest of the extension story lives, and a destination in two neighbouring menus teaches the reader
        // that the bar has no shape.
        sections: [{ items: productItems() }],
        action: { label: "Try the demo workspace", href: DEMO_PATH },
    },
    {
        type: "menu",
        label: "Docs",
        prefixes: ["/docs"],
        // One unlabelled column of four destinations: see docsDestinations for why this is not the tree.
        sections: [{ items: [...docsDestinations] }],
        // Changelog is a Resources row now, and a destination should not sit in two neighbouring menus.
        action: { label: "Troubleshooting", href: docsHref("troubleshooting") },
    },
    /* Resources: what a visitor reads while making up their mind, in the order it is read: guides before they
     * know the product exists, blog and comparisons once they do, changelog after installing, community when
     * a page did not answer. Blog posts are markdown files this module cannot read, so that row has no `covers`. */
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
    /* Developers: everything for somebody building ON intentic. It was four bar labels (Developers, API,
     * Extensions, Earn); all four readers have already decided to build and will open a menu. The API, the
     * gallery and the economy are one row each pointing at an index: the /api/ shelf tree is the rail on the
     * /api/ pages themselves. */
    {
        type: "menu",
        label: "Developers",
        prefixes: ["/developers", "/api", "/extensions", "/earn"],
        sections: [
            {
                items: [
                    ...developersDestinations,
                    developersServicesDestination,
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
                    {
                        label: "Earn & the creator pool",
                        href: "/earn/",
                        description: "What a spent credit pays out",
                        icon: "coins",
                        covers: ["/earn/", "/earn/ledger/", "/earn/catalog/", "/earn/fine-print/"],
                    },
                ],
            },
        ],
        action: { label: "Download the OpenAPI document", href: `${referenceHref("")}openapi.json` },
    },
    // "Pricing" is the highest-intent click on a developer-tool site; a visitor who finds no link assumes
    // the price is hidden. The page says "free". Decision 2026-09-06, landing-blueprint.md.
    {
        type: "link",
        label: "Pricing",
        href: "/pricing/",
        prefix: "/pricing",
    },
    // Last of the text links, where a bar conventionally keeps it, and in the bar at all because "who is
    // behind this?" is a question about TRUST, and the reader with it is deciding whether to run a container
    // on their own machine and hand it real credentials. That reader will not go looking in the footer.
    {
        type: "link",
        label: "About",
        href: "/about/",
        prefix: "/about",
    },
];
