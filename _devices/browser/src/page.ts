/* WHAT A PAGE LOOKS LIKE TO AN AGENT, and how that is written down for one to read.
 *
 * Split out of types.ts and snapshot.ts so it can be imported by things that are not this driver: the browser
 * EXTENSION (_devices/webext) drives the person's own Chrome through Chrome's own APIs rather than over CDP,
 * and none of this package's socket code can run there — but the two surfaces must speak the same language, or
 * an agent that learned `[e4] button "Send"` in one browser has to learn a second dialect for the other. This
 * module is that language: the shape, the rendering, and what a reference means.
 *
 * Everything here is pure and DOM-free (the walk that produces it is not — that is each driver's own), so it
 * type-checks in a node build and a browser bundle alike, and it is the part of both drivers that can be tested
 * without a browser at all. */

// One thing on the page the agent can act on. `ref` is opaque and only valid until the next snapshot: the page
// may have re-rendered, and a stale reference must fail rather than click whatever now occupies that slot.
export interface PageElement {
    readonly ref: string;
    // What it IS, in the words a person uses: link, button, textbox, checkbox, heading.
    readonly role: string;
    // What it SAYS, its accessible name: the label, the placeholder, the alt text, or its own text.
    readonly name: string;
    // What it currently HOLDS, for anything with a value. Absent for the rest.
    readonly value?: string | undefined;
}

export interface PageState {
    readonly url: string;
    readonly title: string;
    readonly elements: readonly PageElement[];
}

// Beyond this the list is more noise than help: a search-results page can hold thousands of links, and a model
// reading two hundred of them has already lost the thread. Truncation is reported so it is never silent.
export const MAX_ELEMENTS = 150;

/* The agent-facing rendering. One line per element, the ref first because that is what gets passed back, then
 * what it is and what it says — the shape a person scanning for "the Send button" reads fastest. */
export const renderPage = (page: PageState, truncated = false): string => {
    const header = [`Page: ${page.title === "" ? "(untitled)" : page.title}`, page.url];
    if (page.elements.length === 0) {
        return [...header, "", "Nothing on this page can be clicked or typed into: try reading its text instead."].join("\n");
    }
    const rows = page.elements.map((element) => {
        const said = element.name === "" ? "" : ` "${element.name}"`;
        const holds = element.value === undefined || element.value === "" ? "" : ` = "${element.value}"`;
        return `[${element.ref}] ${element.role}${said}${holds}`;
    });
    const note = truncated ? [`(only the first ${MAX_ELEMENTS} are listed, scroll or narrow the page to see more)`] : [];
    return [...header, "", ...rows, ...note].join("\n");
};

// A snapshot as it comes back from whatever ran the walk: a CDP evaluate here, a chrome.scripting result in the
// extension. Every field optional, because a page that navigated mid-call answers with less than it promised.
export interface RawSnapshot {
    readonly url?: string;
    readonly title?: string;
    readonly truncated?: boolean;
    readonly elements?: readonly PageElement[];
}

export const toPageState = (raw: RawSnapshot): PageState => ({
    url: raw.url ?? "",
    title: raw.title ?? "",
    elements: raw.elements ?? [],
});

// Which slot in the page's ref array a reference names. Rejects anything that is not one of ours, so a model
// improvising a CSS selector gets a clear refusal rather than a mysterious no-op.
export const refIndex = (ref: string): number => {
    const match = /^e(\d+)$/.exec(ref.trim());
    return match?.[1] === undefined ? -1 : Number(match[1]);
};
