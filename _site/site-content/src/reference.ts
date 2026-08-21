import { specShelves } from "@intentic/sandbox-openapi/groups";
import { type Book, type BookPage, type BookSection, bookDestinations, bookHref, bookPages } from "./book";

/* /api: every call a sandbox answers, for somebody writing a program against one.
 *
 * THE ONLY GENERATED BOOK ON THE SITE. /docs and /developers are trees somebody sat down and wrote; the
 * reference shelves below are BUILT from `@intentic/sandbox-openapi`, which is itself built from the wire
 * contract the daemon and its browser client both import. A route added to the contract is a page here on the
 * next build, described in the shapes it actually has, and there is no list anywhere that a reviewer has to
 * remember to update.
 *
 * WHY IT IS ITS OWN BOOK RATHER THAN A SHELF INSIDE /developers. The prose page at /developers/http said, and
 * was right to say, that it would not enumerate the routes because "the enumeration is what dates fastest".
 * That argument holds against a hand-written enumeration and collapses against a generated one, so the
 * enumeration now exists — but it is 255 calls across 37 groups, which is larger than the entire authoring
 * book it would have been filed inside. A shelf that outweighs its book is a book.
 *
 * The reader is different too, which is the site's own test for where a cut goes. /docs is for somebody using
 * intentic, /developers for somebody extending it, /api for somebody CALLING it: a script, a dashboard, another
 * agent. The middle reader writes a manifest; this one writes a request.
 *
 * FIVE HAND-WRITTEN PAGES OPEN IT, and they are the things no schema can state: where the sandbox is, which
 * credential a call carries, where input rides, what a failure looks like, and how a stream is read. Everything
 * after them is generated. The split is deliberate and visible in the rail: one shelf you read, seven you look
 * things up in.
 */

/** Today's shelves, resolved once: each carries its groups in the generator's own reading order. */
const shelves = specShelves();

/* The dates. A generated page has no authoring history to read one from, and `datePublished` is a real claim in
 * the structured data every page emits, so it cannot be omitted or invented per page. Both are the day this
 * book was published; the site takes `dateModified` from git, which for a generated page is the day its
 * generator last changed, and that is the honest answer. */
const PUBLISHED = "2026-08-21";

/* THE OPENING SHELF, and the one part of this book somebody writes by hand. Each of these answers a question a
 * reader has BEFORE any individual route makes sense, and none of them is answerable from a schema: a contract
 * knows a route's shape and knows nothing about where the sandbox lives or what a 409 means. */
const startHere: BookSection = {
    label: "Start here",
    audience: "Where your sandbox is, what a call carries, and what comes back.",
    entry: "",
    groups: [
        {
            items: [
                {
                    id: "",
                    title: "Overview",
                    blurb: "Every call your sandbox answers, and a playground that answers them back",
                    meta: {
                        title: "Sandbox API · intentic",
                        description:
                            "Every HTTP call an intentic sandbox answers, generated from the wire contract itself, with a playground that responds in your own browser. No sign-in, no setup.",
                        datePublished: PUBLISHED,
                    },
                },
                {
                    id: "auth",
                    title: "Authorising a call",
                    blurb: "Sessions for a person, control tokens for a program, and what each scope reaches",
                    meta: {
                        title: "Authorising a sandbox API call · intentic",
                        description:
                            "Two credentials reach an intentic sandbox: a session for a signed-in person and a control token for a program. What each one is, how to get it, and what the four scopes reach.",
                        datePublished: PUBLISHED,
                    },
                },
                {
                    id: "calls",
                    title: "The shape of a call",
                    blurb: "Where input rides, what comes back, and the conventions that cover all 255",
                    meta: {
                        title: "The shape of a sandbox API call · intentic",
                        description:
                            "Input rides the query string on a GET and a JSON body on everything else, including DELETE. The base address, the two conventions, and the routes that answer bytes instead of JSON.",
                        datePublished: PUBLISHED,
                    },
                },
                {
                    id: "errors",
                    title: "When a call fails",
                    blurb: "Every status this API returns, and what each one actually means",
                    meta: {
                        title: "Sandbox API failures · intentic",
                        description:
                            "A refusal is a result, not a crash: every failure comes back as JSON with a message. What each status means on an intentic sandbox, and which ones are worth retrying.",
                        datePublished: PUBLISHED,
                    },
                },
                {
                    id: "streams",
                    title: "Streams",
                    blurb: "The long-lived feeds, and the frames each one sends",
                    meta: {
                        title: "Sandbox API streams · intentic",
                        /* No count in this sentence, deliberately. The page itself counts the streaming routes
                         * out of the contract, so a number written here would be a second answer to a question
                         * that already has a generated one, and would be wrong the first time a route started
                         * or stopped streaming. It was, within a day of being written. */
                        description:
                            "Some routes answer a stream rather than a value: watching a turn, the sandbox-wide event feed, and the operations that take minutes. How to read one, and what each frame carries.",
                        datePublished: PUBLISHED,
                    },
                },
            ],
        },
    ],
};

/** One generated page per route group: the id is the group's own key, which is also its first path segment. */
const groupPage = (group: { name: string; label: string; summary: string; description: string }): BookPage => ({
    id: group.name,
    title: group.label,
    blurb: group.summary,
    meta: {
        title: `${group.label} · intentic sandbox API`,
        /* The group's own summary, trimmed to what a search result will actually show. `description` runs to a
         * paragraph and would be cut mid-sentence; `summary` is one line by construction and is guarded against
         * a trailing period, so the sentence this builds closes cleanly. */
        description: `${group.summary}. Every route in the ${group.label.toLowerCase()} group of the intentic sandbox API, with its input, its answer and a playground.`,
        datePublished: PUBLISHED,
    },
});

const referenceSections: BookSection[] = shelves.map(({ shelf, groups }) => ({
    label: shelf.label,
    audience: shelf.audience,
    // The shelf's first group: a nav row has to land on a real page, and a shelf heading is not one.
    entry: groups[0]?.name ?? "",
    groups: [{ items: groups.map(groupPage) }],
}));

export const referenceBook: Book = {
    id: "api",
    label: "API",
    sections: [startHere, ...referenceSections],
};

export const referencePages = bookPages(referenceBook);
export const referenceDestinations = bookDestinations(referenceBook);

export function referenceHref(id: string): string {
    return bookHref(referenceBook, id);
}

/* THE ONE COLLISION THIS BOOK CAN HAVE, turned into a build failure rather than a silent shadowing.
 *
 * The five hand-written pages are real files under src/pages/api/; the 37 generated ones are one dynamic route.
 * Astro resolves a static file ahead of a dynamic one, so a contract group named `errors` or `streams` would
 * not 404 — it would quietly render the hand-written page in its place, and the group would vanish from the
 * site while remaining in the rail, the sitemap and the search index. That is precisely the failure a reader
 * cannot report, because from the outside it looks like a page that exists. */
const handWritten = new Set(startHere.groups.flatMap((group) => group.items.map((page) => page.id)));
const shadowed = shelves.flatMap(({ groups }) => groups.map((group) => group.name)).filter((name) => handWritten.has(name));
if (shadowed.length > 0) {
    throw new Error(`The api book has route groups whose names collide with its hand-written pages: ${shadowed.join(", ")}. Rename one or the other.`);
}

/** Every route group as a flat list, in reading order: what the reference index and the group route iterate. */
export const referenceGroups = shelves.flatMap(({ shelf, groups }) => groups.map((group) => ({ shelf, group })));
