import { apiDestinations } from "./api";
import { docsDestinations } from "./docs";
import type { ShotImage } from "./landing";
import { productHref, productPages } from "./product";
import { DEMO_PATH } from "./site";

/* The site's navigation, as data.
 *
 * Three menus, and all are grouped: a flat list of ten docs pages made "Manifest reference" a peer of
 * "Overview", and the product used to be five anchors into one long page — nothing you could link to, rank,
 * or illustrate. Each row now carries a line of scent, and the product rows carry the screenshot the page
 * opens on, which the mega-menu previews.
 *
 * Compare is NOT in the bar, and that is the deliberate omission here. The hub's own headline is "Most of
 * these are not competitors" — a reframe, and a reframe only lands on somebody who already had the doubt.
 * A permanent tab announces the doubt to everyone else, naming a field of rivals to a visitor who had not
 * thought to look for one. The bar is also the site's scarcest space, spent best on what people RETURN to
 * (Features, Docs) or act on (Get started); a comparison is read once, by someone search already sent
 * straight to it.
 *
 * It stays reachable in the two places that matter: a full column in the footer, sitewide, which is what
 * keeps every comparison page linked; and the home page FAQ, where the row that asks the question links the
 * hub — the moment the doubt actually forms, rather than before it.
 *
 * Download is the second deliberate omission, and for a different reason. The app is not a way INTO the
 * product — both roads end at the same signed-in workspace, and what it replaces is one step, the terminal
 * command that puts a sandbox on your machine. A permanent tab beside "Get started free" therefore offers
 * two openings where there is one, and most of the people who take it are first-timers clicking the most
 * concrete-sounding word in the bar: they get a longer road to the same place, a binary to install before
 * they know what it is for, and on a Mac no build at all. That cost is paid on every page view; the
 * returning reader installing on a second machine, who is the case FOR the tab, arrives rarely.
 *
 * So it lives where the need is instead: the Resources column of the footer, sitewide, and the band of the
 * home page that asks for a terminal — beside the command, at the moment the hesitation lands.
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

/* Every feature page as a menu row, in the shelf's own order — five verbs (Orchestrate, Empower, Automate,
 * Supervise, Delegate) rather than a list of surfaces, so the menu reads as what you DO with a fleet, not the
 * furniture any editor has.
 *
 * ONE COLUMN, no group labels: a verb is its own grouping, so the run/environment/extend headers that once
 * sorted seven surfaces would be more scaffolding than the rows under them. What the menu is FOR is the
 * preview rail beside it — a visitor who has installed nothing seeing the real surfaces — and Automate carries
 * no shot because it is diagram-led (no captured automations screen), so its row simply has no preview. */
const productItems = (): MenuItem[] =>
    productPages.map((page) => ({
        label: page.navLabel,
        href: productHref(page.slug),
        description: page.menuBlurb,
        ...(page.hero ? { shot: { name: page.hero.name, alt: page.hero.alt } } : {}),
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
        // The changelog as the panel's action rather than a seventh link in the bar. It is the same question
        // the docs answer — what does this thing do — asked about the last two weeks of it, and it was the
        // one row of the bar a visitor reads once a release.
        //
        // Points at OUR page rather than at the GitHub releases it used to: a visitor asking what changed wants
        // the handful of things they would notice, and what they got was every commit in the range, subject
        // lines and all. The exhaustive list is still one click further on (/changelog/ links each entry to its
        // release), which is the right order — the readable answer first, the audit trail behind it.
        action: { label: "Changelog", href: "/changelog/" },
    },
    /* The authoring book, its own entry in the bar rather than a shelf inside Docs — the split this whole tree
     * exists to make. Two rows, because the book has two shelves and the reason a reader picks one over the
     * other is the audience line under each: one is walked front to back, the other is opened at a field name.
     *
     * The gallery is the ACTION here, the way the changelog is under Docs. It is the answer to the question an
     * author arrives with — what does a listed extension actually look like — and the row it would otherwise
     * be is already two items to the right in this same bar. */
    {
        type: "menu",
        label: "API",
        prefix: "/api",
        sections: [{ items: [...apiDestinations] }],
        action: { label: "Browse the gallery", href: "/extensions/" },
    },
    // A bare link: the gallery's contents come from the registry repo at build time, so there is no authored
    // list here to build a menu out of.
    {
        type: "link",
        label: "Extensions",
        href: "/extensions/",
        prefix: "/extensions",
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
