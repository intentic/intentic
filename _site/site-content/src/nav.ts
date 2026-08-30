import { developersDestinations, developersServicesDestination } from "./developers";
import { docsDestinations } from "./docs";
import type { ShotImage } from "./landing";
import { productHref, productPages } from "./product";
import { referenceDestinations, referenceHref } from "./reference";
import { DEMO_PATH } from "./site";

/* The site's navigation, as data.
 *
 * Three menus, and all are grouped: a flat list of ten docs pages made "Manifest reference" a peer of
 * "Overview", and the product used to be five anchors into one long page: nothing you could link to, rank,
 * or illustrate. Each row now carries a line of scent, and the product rows carry the screenshot the page
 * opens on, which the mega-menu previews.
 *
 * Compare is NOT in the bar, and that is the deliberate omission here. A visitor looks for a comparison
 * after a specific doubt forms; a permanent tab would introduce a field of rivals before that question
 * exists. The bar is also the site's scarcest space, spent best on what people RETURN to (Features, Docs) or
 * act on (Get started). A comparison is usually read once, by someone search already sent straight to it.
 *
 * It stays reachable in the two places that matter: a full column in the footer, sitewide, which is what
 * keeps every comparison page linked; and the home page FAQ, where the row that asks the question links the
 * hub: the moment the doubt actually forms, rather than before it.
 *
 * Download is the second deliberate omission, and for a different reason. The app is not a way INTO the
 * product: both roads end at the same signed-in workspace, and what it replaces is one step, the terminal
 * command that puts a sandbox on your machine. A permanent tab beside "Get started free" therefore offers
 * two openings where there is one, and most of the people who take it are first-timers clicking the most
 * concrete-sounding word in the bar: they get a longer road to the same place, a binary to install before
 * they know what it is for, and on a Mac no build at all. That cost is paid on every page view; the
 * returning reader installing on a second machine, who is the case FOR the tab, arrives rarely.
 *
 * So it lives where the need is instead: the Resources column of the footer, sitewide, and the band of the
 * home page that asks for a terminal: beside the command, at the moment the hesitation lands.
 */

export interface MenuItem {
    label: string;
    href: string;
    /** One short line under the label: what the page answers. Omitted for a menu that shows labels alone. */
    description?: string;
    /** Icon key drawn to the left of the label, resolved by the site's `navIcons`. */
    icon?: string;
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
        prefix: "/features",
        // The extension gallery is NOT a row here: it is already "Extensions" in this same bar, two items to
        // the right, and a menu whose neighbour duplicates it teaches the reader that the bar has no shape.
        sections: [{ items: productItems() }],
        action: { label: "Try the demo workspace", href: DEMO_PATH },
    },
    {
        type: "menu",
        label: "Docs",
        prefix: "/docs",
        // One unlabelled column of four destinations: see docsDestinations for why this is not the tree.
        sections: [{ items: [...docsDestinations] }],
        // The changelog as the panel's action rather than a seventh link in the bar. It is the same question
        // the docs answer to "what does this thing do?" asked about the last two weeks of it, and it was the
        // one row of the bar a visitor reads once a release.
        //
        // Points at OUR page rather than at the GitHub releases it used to: a visitor asking what changed wants
        // the handful of things they would notice, and what they got was every commit in the range, subject
        // lines and all. The exhaustive list is still one click further on (/changelog/ links each entry to its
        // release), which is the right order: the readable answer first, the audit trail behind it.
        action: { label: "Changelog", href: "/changelog/" },
    },
    /* The authoring book, its own entry in the bar rather than a shelf inside Docs: the split this whole tree
     * exists to make. Two shelf rows, and the reason a reader picks one over the other is the audience
     * line under each: Build is the code, Ship is the process. "Developers" rather than "API" because the menu
     * holds both jobs, and a bar that says "API" over registry policy is promising reference it isn't holding.
     * The path now says "Developers" too, for the same reason the feature pages moved: see the Features entry
     * above. The old /api/* paths are forwarded in worker.ts.
     *
     * THE THIRD ROW IS A PAGE, not a shelf, and it is the second thing you can ship here. Both artifacts are
     * now named on the one surface every visitor passes: the shelves cover the extension, and the service
     * gets the row it cannot get any other way, because one endpoint will never be a shelf of its own. This
     * is the ONLY place the derived-from-shelves rule bends, and it bends because the rule was written to
     * stop a menu listing twenty pages, not to hide one of two artifacts (see developersServicesDestination).
     *
     * It is a menu row rather than a top-level label on purpose. In the bar it would read as a peer
     * destination, announcing a paid-service catalog to every visitor who has no endpoint to sell, and the
     * bar is already six labels, two marks and a button wide. Inside the menu it costs nobody
     * anything: whoever opened "Developers" is already the audience it is written for.
     *
     * The gallery is the ACTION here, the way the changelog is under Docs. It is the answer to the question an
     * author arrives with: what does a listed extension actually look like, and the row it would otherwise
     * be is already two items to the right in this same bar. */
    {
        type: "menu",
        label: "Developers",
        prefix: "/developers",
        sections: [{ items: [...developersDestinations, developersServicesDestination] }],
        action: { label: "Browse the gallery", href: "/extensions/" },
    },
    /* THE WIRE API, its own label rather than a row inside Developers, and this is the one place the bar was
     * genuinely worth widening for.
     *
     * The two books next to each other are a fair test of the site's own cut, which is by READER. Developers is
     * written for somebody extending intentic: they write a manifest, ship a bundle, get listed. This is for
     * somebody CALLING a sandbox: a script, a dashboard, another agent, none of which will ever author an
     * extension. Filed as a row under Developers, the whole HTTP surface would have been announced only to
     * people who had already decided they were writing an extension.
     *
     * It is also simply bigger than the book it would have joined: 269 calls across 39 groups, against eight
     * authored pages. A shelf that outweighs its book is a book.
     *
     * "API" is the accurate word here, and it is the word Developers gave up (see developers.ts): that book
     * holds registry policy and trust definitions alongside its reference, and "API" over those was a promise
     * it did not keep. Over this it is exactly the promise being made.
     *
     * The rows are the reference's own shelves, derived like every other menu, so a shelf added to the
     * generated tree is a menu row without an edit here. The action is the document itself, for a reader whose
     * next move is to point their own tooling at it rather than to read anything. */
    {
        type: "menu",
        label: "API",
        prefix: "/api",
        sections: [{ items: [...referenceDestinations] }],
        action: { label: "Download the OpenAPI document", href: `${referenceHref("")}openapi.json` },
    },
    // A bare link: the gallery's contents come from the registry repo at build time, so there is no authored
    // list here to build a menu out of.
    {
        type: "link",
        label: "Extensions",
        href: "/extensions/",
        prefix: "/extensions",
    },
    /* The economy, top-level: the one system on the site with two audiences. A member asking what the
     * membership buys and a creator asking what the split is are both sent to one page, and neither should
     * have to look for money inside a developer menu. It sits beside Extensions because they are two halves
     * of one story: what's listed, and how what's listed is paid for. */
    {
        type: "link",
        label: "Earn",
        href: "/earn/",
        prefix: "/earn",
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
