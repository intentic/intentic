import { type Book, bookDestinations, bookHref, bookPages } from "./book";

/* /api — written for somebody BUILDING ON intentic, the way code.visualstudio.com/api is. Everything here has
 * one reader: an author. The person installing what they made reads /docs.
 *
 * WHY THIS IS ITS OWN BOOK. It was one shelf of a user manual, and it could not hold what it had to. An
 * extension's life has six steps — build, list, verify, discover, install, earn — and the four that belong to
 * the author each need a page of their own rather than a heading inside somebody else's. Wedged into /docs they
 * were two pages doing five jobs: one of them opened with authoring a manifest and closed with a revenue split.
 *
 * TWO SHELVES, AND THEY ARE DIFFERENT KINDS OF READING. The lifecycle is walked once, front to back, by someone
 * shipping their first extension. The reference is never walked at all — it is opened at a field name by someone
 * who already shipped one. Putting a forty-row route table in the same run as a getting-started guide made the
 * guide look like reference material and the reference look optional.
 *
 * THE TWO MISSING STEPS ARE DELIBERATE. Discover and install are things a USER does, so they are written once, in
 * /docs, and the overview's lifecycle strip links out to them rather than restating them here. An author still
 * meets them — as the experience their listing produces, which is the useful framing anyway. */
export const apiBook: Book = {
    id: "api",
    label: "API",
    sections: [
        {
            /* Named for the JOURNEY rather than the noun. "Extensions" as a shelf label put the reader in a
             * category; "Extension lifecycle" tells them the five rows under it are in order and that following
             * them is the point — which is the one thing a first-time author most needs to be told. */
            label: "Extension lifecycle",
            audience: "Author one, ship it, get it verified, earn from it.",
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
                                    "Author an intentic extension end to end: manifest, activate(), a rail view — then a sha-pinned install, or run it straight from your workspace.",
                                datePublished: "2026-07-31",
                            },
                        },
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
                             * claim two different people act on — an author deciding whether it is worth pursuing, and
                             * a user deciding whether to install — and buried under a heading about registries it was
                             * unfindable to both. Searching "verified" returned the gallery and nothing else. */
                            id: "verify",
                            title: "Verification & trust",
                            blurb: "What listed, verified and blocked each actually claim",
                            meta: {
                                title: "Verification & trust · intentic API",
                                description:
                                    "What listed, verified and blocked each mean, the nightly check behind them, and precisely what sha pinning, the manifest gate and registry review do and do not guarantee.",
                                datePublished: "2026-08-11",
                            },
                        },
                        {
                            /* Last of the lifecycle, because it is the last question an author has: build it, list it,
                             * get it read, get paid for it. */
                            id: "earn",
                            title: "The creator pool",
                            blurb: "Premium listings, credits, the revenue split, and the public ledger",
                            meta: {
                                title: "The creator pool · intentic API",
                                description:
                                    "How premium extensions and services earn: the membership, daily credits, install donations with no telemetry anywhere, per-run service pricing with no charge on failure, the published split, and the transparency ledger anyone can read.",
                                datePublished: "2026-08-10",
                            },
                        },
                    ],
                },
            ],
        },
        {
            label: "Reference",
            audience: "Every field and every route, for looking up.",
            entry: "manifest",
            groups: [
                {
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
                                    "Every member of the IntenticApi object — the typed daemon client, views, documents, commands, models, routing — and the backend's activateServer surface.",
                                datePublished: "2026-08-07",
                            },
                        },
                        {
                            /* A PEER of the host API, not a child of it: one is the daemon you call over the wire, the
                             * other is the object an extension is handed in-process. A reader is picking between them,
                             * and nesting one under the other said the wire API was a detail of the in-process one. */
                            id: "http",
                            title: "HTTP API",
                            blurb: "Every route your sandbox serves, and the credential to call it",
                            meta: {
                                title: "Sandbox HTTP API · intentic API",
                                description:
                                    "Call your own sandbox over HTTP: the base URL, control tokens and their scopes, the route groups, the event streams, and the failures.",
                                datePublished: "2026-08-07",
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

export const apiPages = bookPages(apiBook);
export const apiDestinations = bookDestinations(apiBook);

export function apiHref(id: string): string {
    return bookHref(apiBook, id);
}

/* THE SIX STEPS, in order, with the page that owns each — the strip the API overview and the gallery both draw.
 *
 * It exists as data because two very different surfaces render it and they were drifting: the gallery drew five
 * grey chips and an "Earn" pill, none of them a link, while the docs described a lifecycle with no picture of it
 * anywhere. Two of the six deliberately point OUT of this book, into /docs, because they are what the reader on
 * the other side of the listing does. */
export const extensionLifecycle: readonly { step: string; href: string; what: string; audience: "author" | "user" }[] = [
    { step: "Build", href: apiHref("build"), what: "A directory with a manifest, in your own repo.", audience: "author" },
    { step: "List", href: apiHref("publish"), what: "One topic, and a pull request opens itself.", audience: "author" },
    { step: "Verify", href: apiHref("verify"), what: "The pointer is checked; the code may be read.", audience: "author" },
    { step: "Discover", href: "/extensions/", what: "The gallery, and browse from inside the app.", audience: "user" },
    { step: "Install", href: "/docs/extensions/", what: "One commit, approved by its owner.", audience: "user" },
    { step: "Earn", href: apiHref("earn"), what: "Premium listings draw from the creator pool.", audience: "author" },
];
