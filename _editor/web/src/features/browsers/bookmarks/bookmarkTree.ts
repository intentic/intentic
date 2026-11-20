import type { BookmarkNode, BookmarkRoot } from "@intentic/sandbox-contract/schemas/bookmarks";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";

// The bookmarks tree as the editor reads it, from the daemon's flat depth-first list (schemas/bookmarks.ts): what is in
// a folder, which bookmark a page is, the folders to file one in, and what the address bar's rows draw from them.

// An address as bookmarks compare it: a bare site's trailing slash is no difference.
const sameAddress = (left: string, right: string): boolean => left.replace(/\/$/, ``) === right.replace(/\/$/, ``);

/** Whether a page can be kept at all: the web, never a blank tab or Chromium's own pages. */
export const bookmarkable = (url: string | undefined): url is string => url !== undefined && /^https?:\/\/[^/]/i.test(url);

/** The bookmark of a page, the first made where several keep the same address; undefined for a page not kept. */
export const bookmarkFor = (nodes: readonly BookmarkNode[], url: string | undefined): BookmarkNode | undefined =>
    url === undefined || url === `` ? undefined : nodes.find((node) => node.kind === `url` && node.url !== undefined && sameAddress(node.url, url));

/** A folder's contents, in their order. */
export const childrenOf = (nodes: readonly BookmarkNode[], folder: string): BookmarkNode[] => nodes.filter((node) => node.parent === folder);

/** Whether `id` is `folder` or anything inside it: where a folder cannot be moved, and what a removal takes along. */
export const isWithin = (nodes: readonly BookmarkNode[], id: string, folder: string): boolean => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (let at: string | undefined = id; at !== undefined; at = byId.get(at)?.parent) {
        if (at === folder) {
            return true;
        }
    }
    return false;
};

export interface FolderChoice {
    readonly id: string;
    readonly title: string;
    // Where it sits, from its root down, as a picker names it: "Bookmarks bar › Work › Docs".
    readonly path: string;
    // How deep it sits: 0 for the two roots.
    readonly depth: number;
}

/**
 * Where a node dragged onto `target` lands: just before it, in its folder, counted as the daemon counts a move (among
 * what the folder holds without the node being moved).
 */
export const dropIndex = (nodes: readonly BookmarkNode[], id: string, target: BookmarkNode): number =>
    childrenOf(nodes, target.parent ?? ``)
        .filter((node) => node.id !== id)
        .findIndex((node) => node.id === target.id);

/** The list as it stands once `id` is moved to `index` in `parent`, depth first like the daemon's: what a drag shows. */
export const withMove = (nodes: readonly BookmarkNode[], id: string, parent: string, index: number): BookmarkNode[] => {
    const moving = nodes.find((node) => node.id === id);
    if (moving === undefined) {
        return [...nodes];
    }
    const moved = { ...moving, parent };
    const kids = (folder: string): BookmarkNode[] => {
        const list = nodes.filter((node) => node.parent === folder && node.id !== id);
        if (folder === parent) {
            list.splice(Math.min(index, list.length), 0, moved);
        }
        return list;
    };
    const out: BookmarkNode[] = [];
    const walk = (folder: string): void => {
        for (const kid of kids(folder)) {
            out.push(kid);
            walk(kid.id);
        }
    };
    for (const root of nodes.filter((node) => node.parent === undefined)) {
        out.push(root);
        walk(root.id);
    }
    return out;
};

// How a press asks for a page: Ctrl, ⌘ or the middle button opens it in a new tab.
export interface OpenGesture {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly button?: number;
}

export const wantsNewTab = (gesture: OpenGesture): boolean => gesture.ctrlKey || gesture.metaKey || gesture.button === 1;

/** Every folder, depth first, with its path: what a bookmark can be filed in. The roots are named by the caller. */
export const folderChoices = (nodes: readonly BookmarkNode[], rootTitle: (root: BookmarkRoot) => string): FolderChoice[] => {
    const byId = new Map<string, FolderChoice>();
    const choices: FolderChoice[] = [];
    for (const node of nodes) {
        if (node.kind !== `folder`) {
            continue;
        }
        const above = node.parent === undefined ? undefined : byId.get(node.parent);
        const title = node.id === `bar` || node.id === `other` ? rootTitle(node.id) : node.title;
        const choice = { id: node.id, title, path: above === undefined ? title : `${above.path} › ${title}`, depth: above === undefined ? 0 : above.depth + 1 };
        byId.set(node.id, choice);
        choices.push(choice);
    }
    return choices;
};

/** The bookmarks whose title or address holds every word typed, case aside. */
export const searchBookmarks = (nodes: readonly BookmarkNode[], search: string): BookmarkNode[] => {
    const words = search.toLowerCase().split(/\s+/u).filter((word) => word !== ``);
    return nodes.filter(
        (node) => node.kind === `url` && words.every((word) => `${node.title} ${node.url ?? ``}`.toLowerCase().includes(word)),
    );
};

// A site as the address bar's rows group it (omnibox/rank.ts's `host`): lower-cased, no scheme, no `www.`, no path.
export const siteOf = (url: string): string => {
    const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ``).toLowerCase();
    const site = bare.startsWith(`www.`) ? bare.slice(4) : bare;
    const slash = site.indexOf(`/`);
    return slash === -1 ? site : site.slice(0, slash);
};

// What the address bar knows of pages besides their history: which are kept as bookmarks (under what name, with what
// icon), and each site's icon as an open tab or a bookmark carries it.
export interface PageMarks {
    readonly bookmarks: ReadonlyMap<string, { readonly title: string; readonly favicon: string | undefined }>;
    readonly icons: ReadonlyMap<string, string>;
}

export const NO_MARKS: PageMarks = { bookmarks: new Map(), icons: new Map() };

/** The marks for a profile's bookmarks and the pages open now; an open tab's icon wins, being the newest. */
export const pageMarks = (nodes: readonly BookmarkNode[], pages: readonly BrowserPage[]): PageMarks => {
    const bookmarks = new Map<string, { readonly title: string; readonly favicon: string | undefined }>();
    const icons = new Map<string, string>();
    for (const node of nodes) {
        if (node.kind === `url` && node.url !== undefined && !bookmarks.has(node.url)) {
            bookmarks.set(node.url, { title: node.title, favicon: node.favicon });
            if (node.favicon !== undefined) {
                icons.set(siteOf(node.url), node.favicon);
            }
        }
    }
    for (const page of pages) {
        if (page.favicon !== undefined && page.url !== ``) {
            icons.set(siteOf(page.url), page.favicon);
        }
    }
    return { bookmarks, icons };
};
