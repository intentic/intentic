import { specShelves } from "@intentic/sandbox-openapi/groups";
import { type Book, type BookPage, type BookSection, bookDestinations, bookHref, bookPages } from "./book";

// /api: every call a sandbox answers, for someone writing a program against one. Generated from
// `@intentic/sandbox-openapi`, built from the wire contract: a route added there is a page here next build. Five
// hand-written pages open it (location, credentials, request shape, failures, streams); the rest is generated.

/** Today's shelves, resolved once: each carries its groups in the generator's own reading order. */
const shelves = specShelves();

// The day this book was published; dateModified comes from git, the day the generator itself last changed.
const PUBLISHED = "2026-08-21";

// The one hand-written shelf; each page answers something a schema can't (sandbox location, what a 409 means).
const startHere: BookSection = {
    label: "Start here",
    icon: "flag",
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
                            "Two credentials reach an intentic sandbox: a session for a signed-in person and a control token for a program. How to get each, and what the scopes reach.",
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
                            "Input rides the query string on a GET and a JSON body on everything else, including DELETE. The base address, the conventions, and the routes answering bytes.",
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
                            "A refusal is a result, not a crash: every failure comes back as JSON with a message. What each status means on a sandbox, and which ones are worth retrying.",
                        datePublished: PUBLISHED,
                    },
                },
                {
                    id: "streams",
                    title: "Streams",
                    blurb: "The long-lived feeds, and the frames each one sends",
                    meta: {
                        title: "Sandbox API streams · intentic",
                        // No route count here: the page counts them from the contract, so this text can't drift out of
                        // sync.
                        description:
                            "Some routes answer a stream rather than a value: watching a turn, the sandbox event feed, the operations that take minutes. How to read one, frame by frame.",
                        datePublished: PUBLISHED,
                    },
                },
            ],
        },
    ],
};

// Search truncates past 160 chars; summary leads, the extra sentence appends only if it fits, else build fails.
const DESCRIPTION_MAX = 160;
const groupDescription = (group: { label: string; summary: string }): string => {
    const lead = `${group.summary.replace(/\.\s*$/u, "")}.`;
    const book = `the ${group.label.toLowerCase()} group of the intentic sandbox API`;
    for (const suffix of [` Every route in ${book}, with its input, its answer and a playground.`, ` Every route in ${book}.`, ""]) {
        if (lead.length + suffix.length <= DESCRIPTION_MAX) {
            return lead + suffix;
        }
    }
    throw new Error(`API group "${group.label}" summary is over ${DESCRIPTION_MAX} characters: ${lead}`);
};

/** One generated page per route group: the id is the group's own key, which is also its first path segment. */
const groupPage = (group: { name: string; label: string; summary: string; description: string }): BookPage => ({
    id: group.name,
    title: group.label,
    blurb: group.summary,
    meta: {
        title: `${group.label} · intentic sandbox API`,
        description: groupDescription(group),
        datePublished: PUBLISHED,
    },
});

// No shelf icons here; nothing in this book's rail draws them.
const referenceSections: BookSection[] = shelves.map(({ shelf, groups }) => ({
    label: shelf.label,
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

// A contract group whose name collides with a hand-written page id (Astro resolves static over dynamic) would silently
// shadow it instead of 404ing. Caught here as a build failure.
const handWritten = new Set(startHere.groups.flatMap((group) => group.items.map((page) => page.id)));
const shadowed = shelves.flatMap(({ groups }) => groups.map((group) => group.name)).filter((name) => handWritten.has(name));
if (shadowed.length > 0) {
    throw new Error(`The api book has route groups whose names collide with its hand-written pages: ${shadowed.join(", ")}. Rename one or the other.`);
}

/** Every route group as a flat list, in reading order: what the reference index and the group route iterate. */
export const referenceGroups = shelves.flatMap(({ shelf, groups }) => groups.map((group) => ({ shelf, group })));
