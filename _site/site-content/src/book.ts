// A Book is one documentation tree: its own root path, rail and search scope. Split by reader (docs, developers, api);
// api's reference is generated from the wire contract but shaped like the others so downstream surfaces read all books
// uniformly. Trees: docs.ts, developers.ts, reference.ts.

export interface BookPage {
    /** Route slug under the book's root; "" is the book's index. */
    id: string;
    /** Sidebar + breadcrumb label. */
    title: string;
    /** One line of scent in the nav menu: shorter than meta.description, which is written for search results. */
    blurb: string;
    /** description ≤160 chars (search truncates past that); dateModified comes from git history, not authored here. */
    meta: { title: string; description: string; datePublished: string };
    /** Real route nesting only, indented in the rail; editorial grouping belongs in a group's label instead. */
    children?: BookPage[];
}

/** A run of rows inside a shelf, optionally under its own sub-heading. */
export interface BookGroup {
    /** Absent for a shelf's main run, where a heading would only repeat the shelf label. */
    label?: string;
    items: BookPage[];
}

export interface BookSection {
    label: string;
    /** Nav menu's scent line: a few words, omitted when a shelf shows its rows as labels alone. */
    tagline?: string;
    /** The nav menu's icon key for this shelf: resolved to a drawing in the site's `navIcons`. */
    icon?: string;
    /** The page this shelf's nav row points at; always a real page. */
    entry: string;
    groups: BookGroup[];
}

export interface Book {
    /** The first path segment, and the word the breadcrumb and the search index use. */
    id: "docs" | "developers" | "api";
    /** The top bar's label and the breadcrumb's root. */
    label: string;
    sections: BookSection[];
}

/** A page with the shelf it sits on: what prev/next and search results need to say where they are. */
export interface BookPlacement {
    page: BookPage;
    section: BookSection;
    group: BookGroup;
}

export function bookHref(book: Book, id: string): string {
    return id ? `/${book.id}/${id}/` : `/${book.id}/`;
}

function walk(page: BookPage): BookPage[] {
    return [page, ...(page.children ?? []).flatMap(walk)];
}

/** Every page in reading order, each carrying the shelf and group it belongs to. */
export function bookPlacements(book: Book): BookPlacement[] {
    return book.sections.flatMap((section) => section.groups.flatMap((group) => group.items.flatMap(walk).map((page) => ({ page, section, group }))));
}

export function bookPages(book: Book): BookPage[] {
    return bookPlacements(book).map((placement) => placement.page);
}

export function bookPage(book: Book, id: string): BookPage | undefined {
    return bookPages(book).find((page) => page.id === id);
}

export function bookPlacement(book: Book, id: string): BookPlacement | undefined {
    return bookPlacements(book).find((placement) => placement.page.id === id);
}

/**
 * One row per shelf (not per page), for the top bar menu and footer column. `covers` lists every page under a shelf so
 * the row can be marked current without the href matching the wrong page.
 */
export function bookDestinations(book: Book): { label: string; href: string; description?: string; icon?: string; covers: string[] }[] {
    return book.sections.map((section) => ({
        label: section.label,
        href: bookHref(book, section.entry),
        // Scent line from authored books; the generated API menu omits it and shows shelves as labels alone.
        description: section.tagline,
        icon: section.icon,
        covers: section.groups.flatMap((group) => group.items.flatMap(walk)).map((page) => bookHref(book, page.id)),
    }));
}

/** Previous/next page within this page's shelf, not across the whole tree; also returns the shelf itself. */
export function bookNeighbours(book: Book, id: string): { section?: BookSection; prev?: BookPage; next?: BookPage } {
    const placements = bookPlacements(book);
    const placement = placements.find((entry) => entry.page.id === id);
    if (placement === undefined) {
        return {};
    }
    const shelf = placements.filter((entry) => entry.section === placement.section).map((entry) => entry.page);
    const index = shelf.findIndex((page) => page.id === id);
    return { section: placement.section, prev: shelf[index - 1], next: shelf[index + 1] };
}
