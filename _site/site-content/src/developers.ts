import { type Book, bookDestinations, bookHref, bookPages } from "./book";

// /developers is written for an author building on intentic, not the installer (/docs). Named for this book, not the
// old /api path: /api is now reference.ts's generated route reference. Two shelves are two jobs: Build is the code
// (format, APIs, reference); Ship is the publishing process (registry, trust, staying listed).
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
                    ],
                },
            ],
        },
        {
            // Named for the flow, not the noun: rows under it are ordered, not a category to browse.
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
                            // Standalone page: "verified" is a claim both an author and an installing user act on.
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
                            // Last because it repeats: everything above happens once per extension, this once per
                            // release.
                            id: "maintain",
                            title: "Maintain & grow",
                            blurb: "Ship updates and stay ranked, release after release",
                            meta: {
                                title: "Maintain & grow an extension · intentic API",
                                description:
                                    "Ship an extension update with one pull request, know when it re-asks for approval, stay ranked in discovery, and how maintenance turns into revenue.",
                                datePublished: "2026-08-11",
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

// Six steps in order, each named for the page it links to (Publish, not "List"; Maintain, not "Update"). Discover and
// Install point out of this book into /docs; the cycle repeats from Maintain.
export const extensionLifecycle: readonly { step: string; href: string; what: string; audience: "author" | "user" }[] = [
    { step: "Build", href: developersHref("build"), what: "A directory with a manifest, in your own repo.", audience: "author" },
    { step: "Publish", href: developersHref("publish"), what: "One topic, and a pull request opens itself.", audience: "author" },
    { step: "Verify", href: developersHref("verify"), what: "The pointer is checked; the code may be read.", audience: "author" },
    { step: "Discover", href: "/extensions/", what: "The gallery, and browse from inside the app.", audience: "user" },
    { step: "Install", href: "/docs/extensions/", what: "One commit, approved by its owner.", audience: "user" },
    { step: "Maintain", href: developersHref("maintain"), what: "A new sha, and the cycle runs again.", audience: "author" },
];
