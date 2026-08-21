/* A BOOK is one documentation tree with its own root path, its own rail and its own search scope.
 *
 * There are three, and the split is by WHO IS READING rather than by subject: /docs is written for someone
 * using intentic, /developers for someone building on it, /api for someone calling it. The first cut is the one
 * code.visualstudio.com makes, and it exists because the two readers share almost no vocabulary: one is
 * deciding whether to trust an extension, the other is deciding what to put in its manifest, while a single
 * rail forced them to scroll past each other's work.
 *
 * THE THIRD BOOK IS NOT HAND-WRITTEN, and that is the only way it differs. /docs and /developers are pages
 * somebody authored; /api's reference shelf is GENERATED from the daemon's wire contract, one page per route
 * group, so a route added to the contract is a documented route the same day. It is a Book anyway, and takes
 * the same shape, because everything downstream, the rail, the bar, the footer, the breadcrumb, the search
 * index, the sitemap, reads books and nothing else: making the generated tree a fourth kind of thing would
 * have meant teaching all six surfaces about it.
 *
 * Everything below is the shape all three share. The trees themselves are docs.ts, developers.ts and
 * reference.ts, and every derived surface, including the rail, top bar, footer, breadcrumb, previous/next
 * links, page metadata, sitemap and search index, is computed from them here. A page can only appear where its
 * book says it does.
 */

export interface BookPage {
    /** Route slug under the book's root; "" is the book's index. */
    id: string;
    /** Sidebar + breadcrumb label. */
    title: string;
    /** One line of scent in the nav menu: shorter than meta.description, which is written for search results. */
    blurb: string;
    /**
     * <title>, meta description and publication date. Descriptions stay under 160 characters: past that
     * a search result truncates mid-sentence and the page loses whatever the tail was carrying.
     * dateModified is not here: it comes from the page's git history at build time.
     */
    meta: { title: string; description: string; datePublished: string };
    /**
     * Pages that live UNDER this one: same shelf, indented in the rail. Only for real route nesting, never as
     * an editorial grouping: that is what a group's label is for, and conflating the two is how "Manifest
     * reference" once came to look like a peer of "Extensions".
     */
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
    /** Who arrives at this shelf and what they want: rendered under the label, in the rail and on the index. */
    audience: string;
    /** The page this shelf's nav row points at. Always a real page, so no menu row is a dead heading. */
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
 * THE TOP BAR'S MENU and the footer's column for a book: one row per shelf, never one per page.
 *
 * Deriving from SHELVES rather than pages is the whole bargain: there are a handful, a new page never adds a
 * row, and the menu cannot describe a shape the rail has stopped having, which is exactly how the two came to
 * disagree when this was nineteen hand-written rows. Each href is the shelf's own entry page, so no row is a
 * dead heading.
 */
export function bookDestinations(book: Book): { label: string; href: string; description: string }[] {
    return book.sections.map((section) => ({
        label: section.label,
        href: bookHref(book, section.entry),
        description: section.audience,
    }));
}

/**
 * The page before and after this one WITHIN ITS SHELF, plus the shelf they belong to.
 *
 * Shelf-scoped rather than tree-wide on purpose: the flat version walked all twenty pages as one line, so the
 * foot of "Your own machine" offered "Parallel agents" as the next thing to read and the docs claimed to be a
 * book you start at the front of. They are shelves you pick one of.
 */
export function bookNeighbours(book: Book, id: string): { section?: BookSection; prev?: BookPage; next?: BookPage } {
    const placements = bookPlacements(book);
    const placement = placements.find((entry) => entry.page.id === id);
    if (placement === undefined) return {};
    const shelf = placements.filter((entry) => entry.section === placement.section).map((entry) => entry.page);
    const index = shelf.findIndex((page) => page.id === id);
    return { section: placement.section, prev: shelf[index - 1], next: shelf[index + 1] };
}
