import { type Book, bookDestinations, bookHref, bookPages } from "./book";

/* /developers: written for somebody BUILDING ON intentic, the way code.visualstudio.com/api is. Everything
 * here has one reader: an author. The person installing what they made reads /docs.
 *
 * THE PATH IS THE MENU LABEL. This book lived at /api/ while the bar above it said "Developers", and the
 * label is the accurate one: the shelves hold a getting-started guide, registry policy and what the trust
 * words mean, and only some of it is reference. "API" over that is a promise of reference the book does not
 * keep, and a reader who clicked "Developers" should not have to notice they landed somewhere else.
 *
 * /api/ NOW KEEPS THAT PROMISE, as its own book (reference.ts): every route the daemon serves, generated from
 * the contract. This file is named for its book rather than for its old path, because a module called api.ts
 * exporting the Developers tree, next to a book that IS the API, is a trap set for the next reader.
 *
 * TWO SHELVES, AND THEY ARE THE TWO JOBS. "Build" is the code: the format, the APIs, a working extension, and
 * the reference you open at a field name. "Ship" is the process: getting a pointer into a registry, what the
 * trust words claim, and staying listed release after release. The old single "lifecycle" shelf braided the
 * two: a reader after a manifest field scrolled through registry policy to reach it, and its last row was
 * money, which belongs to neither.
 *
 * THE MONEY IS NOT IN THIS BOOK. The economy: membership, credits, the pool, the split, the
 * ledger has TWO audiences: the member spending credits and the creator earning them. Filed here it read as
 * a step of publishing and served only half its readers; it now lives at /earn/, top-level, and Ship's
 * lifecycle strip points out to it the same way it points out to /docs for the installer's steps.
 *
 * Inside Build, the guide and the reference stay DIFFERENT KINDS OF READING: the guide is walked once, front
 * to back, by someone shipping their first extension; the reference is never walked at all: it is opened at
 * a field name by someone who already shipped one. The "Reference" group label is what keeps a forty-row
 * route table from making the getting-started guide look like reference material. */
export const developersBook: Book = {
    id: "developers",
    label: "Developers",
    sections: [
        {
            label: "Build",
            tagline: "One format, every surface",
            icon: "code",
            entry: "",
            groups: [
                {
                    items: [
                        {
                            id: "",
                            title: "Overview",
                            blurb: "One format, every surface it can reach, and the whole lifecycle",
                            meta: {
                                title: "Extension API · intentic",
                                description:
                                    "intentic is a lean core plus one extension format: a directory with a manifest whose every part is optional. It extends the agent, the UI and the backend.",
                                datePublished: "2026-07-31",
                            },
                        },
                        {
                            id: "build",
                            title: "Build an extension",
                            blurb: "Author one end to end, in a repo or in your workspace",
                            meta: {
                                title: "Build an extension · intentic API",
                                description:
                                    "Build an intentic extension from manifest to rail view, then install it by pinned commit or run it straight from your workspace.",
                                datePublished: "2026-07-31",
                            },
                        },
                    ],
                },
                {
                    label: "Reference",
                    items: [
                        {
                            id: "manifest",
                            title: "Manifest reference",
                            blurb: "Every field of intentic-extension.json",
                            meta: {
                                title: "Extension manifest reference · intentic API",
                                description:
                                    "Every field of intentic-extension.json: views, viewers, commands, settings, capability cards, processes, listeners, agent plugins, the backend, permissions.",
                                datePublished: "2026-07-31",
                            },
                        },
                        {
                            id: "host",
                            title: "Host API",
                            blurb: "The IntenticApi an extension is handed",
                            meta: {
                                title: "Extension host API reference · intentic API",
                                description:
                                    "Every member of the IntenticApi object: the typed daemon client, views, documents, commands, models and routing, plus the backend's activateServer surface.",
                                datePublished: "2026-08-07",
                            },
                        },
                        /* THE WIRE API USED TO BE A THIRD ROW HERE, and it has left for /api/ (reference.ts).
                         *
                         * It was a page that said, honestly, that it would not enumerate the routes because
                         * "the enumeration is what dates fastest" — and then described 34 groups in a table
                         * that had drifted from the contract by the time anyone read it, listing three groups
                         * the daemon no longer has. The enumeration now exists and is generated, so the page
                         * that stood in for it has nothing left to do.
                         *
                         * Not kept as a pointer, either. A row whose only content is "the thing you want is
                         * over there" costs a click and teaches a reader that this book's rows are unreliable.
                         * The pages that linked to it now link into /api/ directly, at the page that answers
                         * the question each of them was asking, and worker.ts forwards the old address. */
                    ],
                },
            ],
        },
        {
            /* Named for the flow rather than the noun. "Publishing" as a shelf label put the reader in a
             * category; "Ship" tells them the rows under it are in order and that following them is the point.
             * list it, understand what the trust words claim, then keep it alive release after release. */
            label: "Ship",
            tagline: "Get listed, stay listed",
            icon: "rocket",
            entry: "publish",
            groups: [
                {
                    items: [
                        {
                            id: "publish",
                            title: "Publish & registries",
                            blurb: "Your repo stays yours; a listing is a pointer to a commit",
                            meta: {
                                title: "Publish an extension · intentic API",
                                description:
                                    "Your extension stays in your repo; a registry is a git repo of sha-pinned pointers. Add one topic and the pull request that lists you writes itself.",
                                datePublished: "2026-07-31",
                            },
                        },
                        {
                            /* ITS OWN PAGE, though it was four paragraphs inside the publishing guide. "Verified" is a
                             * claim two different people act on: an author deciding whether it is worth pursuing, and
                             * a user deciding whether to install, and buried under a heading about registries it was
                             * unfindable to both. Searching "verified" returned the gallery and nothing else. */
                            id: "verify",
                            title: "Verification & trust",
                            blurb: "What listed, verified and blocked each actually claim",
                            meta: {
                                title: "Verification & trust · intentic API",
                                description:
                                    "What listed, verified and blocked each mean, the nightly check behind them, and what sha pinning and registry review do and do not guarantee.",
                                datePublished: "2026-08-11",
                            },
                        },
                        {
                            /* Last in the extension's run because it is the step that repeats: everything above happens
                             * once per extension; this happens once per release. It existed only as fragments in the
                             * publishing guide, money page and trust page. So "how do I stay listed and keep earning"
                             * had no page to be asked of. */
                            id: "maintain",
                            title: "Maintain & grow",
                            blurb: "Ship updates, stay ranked, and what sustained revenue rests on",
                            meta: {
                                title: "Maintain & grow an extension · intentic API",
                                description:
                                    "Ship an extension update with one pull request, know when it re-asks for approval, stay ranked in discovery, and how maintenance turns into revenue.",
                                datePublished: "2026-08-11",
                            },
                        },
                        {
                            /* THE SECOND KIND OF THING YOU CAN SHIP. It is not an extension: no manifest, no
                             * bundle, no repo pointer, just an HTTPS endpoint the platform forwards metered calls
                             * to. It closes the shelf rather than joining the run above it, because the four pages
                             * above are one artifact's lifecycle and this is a different artifact. Before it, the
                             * provider's story was one honest sentence in /earn/'s fine print and a dead end. */
                            id: "services",
                            /* "PAID" IS LOAD-BEARING IN THE LABEL. "Offer a service" reads as consulting to
                             * half the people who see it, and against a shelf of extension rows the one word
                             * that separates the two artifacts is the money: an extension is free to run and
                             * this is not. The label is the same everywhere it appears, so the footer, the
                             * rail and the two forks that point here cannot teach three vocabularies. */
                            title: "Offer a paid service",
                            blurb: "One endpoint, a signed forward, and a price in credits",
                            meta: {
                                title: "Offer a paid service · intentic API",
                                description:
                                    "Wire a paid service into intentic: one JSON endpoint, the signature to verify, what is paid versus refunded, and how pricing in credits works.",
                                datePublished: "2026-08-12",
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

export const developersPages = bookPages(developersBook);
export const developersDestinations = bookDestinations(developersBook);

export function developersHref(id: string): string {
    return bookHref(developersBook, id);
}

/* THE ONE PAGE THAT IS ALSO A NAV ROW, and the single exception to "the bar shows shelves, not pages".
 *
 * The rule earns its keep for the four extension pages: they are one artifact's lifecycle, they will keep
 * multiplying, and a bar listing them individually would go stale the week someone adds a fifth. A service is
 * the opposite shape. It is one page because it is one endpoint, there is no second page coming, and it is
 * the only OTHER THING YOU CAN SHIP here: filed under a shelf whose entry page is about git registries, the
 * bar told a provider this menu was not about their thing. A rule that hides the second of two artifacts is
 * being applied past the point it was reasoning about.
 *
 * Derived from the book entry rather than retyped, so the row still cannot drift from the page: rename the
 * page and the bar, the phone menu and the footer all follow. The throw is the anti-drift half of the same
 * bargain, turning a page that moved into a loud build failure instead of a blank menu row. */
const servicesPage = developersPages.find((page) => page.id === "services");
if (servicesPage === undefined) throw new Error("The api book has no services page for the nav row to derive from.");

export const developersServicesDestination = {
    label: servicesPage.title,
    href: developersHref(servicesPage.id),
    // A short scent line of its own rather than the page blurb, held to the same few-word budget as every
    // other menu row.
    description: "One endpoint, priced in credits",
    icon: "circle-dollar-sign",
};

/* THE SEVEN STEPS, in order, with the page that owns each: the cycle the API overview draws as a diagram and
 * the gallery draws as a strip of chips.
 *
 * It exists as data because two very different surfaces render it and they were drifting: the gallery drew
 * grey chips that were not links while the docs described a lifecycle with no picture of it anywhere. Three of
 * the seven point OUT of this book: Discover and Install into /docs, because they are what the
 * reader on the other side of the listing does, and Earn to the top-level /earn/, because the economy is a
 * system of its own with two audiences. The last step loops because Maintain makes the revenue renewable,
 * which is why it comes after Earn rather than before it.
 *
 * EVERY STEP IS NAMED FOR THE PAGE IT LINKS TO. Publish, not "List"; Maintain, not "Update", because a chip
 * that says one word and lands on a page titled another teaches the reader that the site has two vocabularies. */
export const extensionLifecycle: readonly { step: string; href: string; what: string; audience: "author" | "user" }[] = [
    { step: "Build", href: developersHref("build"), what: "A directory with a manifest, in your own repo.", audience: "author" },
    { step: "Publish", href: developersHref("publish"), what: "One topic, and a pull request opens itself.", audience: "author" },
    { step: "Verify", href: developersHref("verify"), what: "The pointer is checked; the code may be read.", audience: "author" },
    { step: "Discover", href: "/extensions/", what: "The gallery, and browse from inside the app.", audience: "user" },
    { step: "Install", href: "/docs/extensions/", what: "One commit, approved by its owner.", audience: "user" },
    { step: "Earn", href: "/earn/", what: "Premium listings draw from the creator pool.", audience: "author" },
    { step: "Maintain", href: developersHref("maintain"), what: "A new sha, and the cycle runs again.", audience: "author" },
];
