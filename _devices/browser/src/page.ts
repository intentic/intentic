// Shared page representation for both the CDP driver and the browser extension (which drives Chrome via its own
// APIs, not CDP), so both speak the same ref/rendering language. Pure and DOM-free, so it type-checks and tests
// in a node build and a browser bundle alike.

// One thing on the page the agent can act on; `ref` is opaque and valid only until the next snapshot, so a stale
// one must fail rather than click whatever now sits there.
export interface PageElement {
    readonly ref: string;
    // What it is, in words a person uses: link, button, textbox, checkbox, heading.
    readonly role: string;
    // What it says: accessible name from the label, placeholder, alt text, or its own text.
    readonly name: string;
    // Current value, for anything that has one; absent otherwise.
    readonly value?: string | undefined;
}

export interface PageState {
    readonly url: string;
    readonly title: string;
    readonly elements: readonly PageElement[];
}

// Beyond this the list is more noise than help; truncation is always reported, never silent.
export const MAX_ELEMENTS = 150;

// Agent-facing rendering: one line per element, ref first (what gets passed back), then role and name.
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

// Snapshot as it comes back from whatever ran the walk (CDP evaluate here, chrome.scripting in the extension);
// every field optional since a mid-call navigation answers with less.
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

// Slot in the page's ref array a reference names; rejects anything not one of ours with a clear refusal.
export const refIndex = (ref: string): number => {
    const match = /^e(\d+)$/.exec(ref.trim());
    return match?.[1] === undefined ? -1 : Number(match[1]);
};
