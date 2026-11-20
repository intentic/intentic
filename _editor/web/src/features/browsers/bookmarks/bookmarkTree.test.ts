import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { bookmarkable, bookmarkFor, childrenOf, dropIndex, folderChoices, isWithin, pageMarks, searchBookmarks, siteOf, wantsNewTab, withMove } from "./bookmarkTree";

const AT = 1_790_000_000_000;
const ICON = `data:image/png;base64,QUFB`;

const node = (id: string, title: string, parent: string | undefined, url?: string, favicon?: string): BookmarkNode => {
    const made: BookmarkNode = { id, kind: url === undefined ? `folder` : `url`, title, added: AT };
    if (parent !== undefined) {
        made.parent = parent;
    }
    if (url !== undefined) {
        made.url = url;
    }
    if (favicon !== undefined) {
        made.favicon = favicon;
    }
    return made;
};

// As the daemon lists it: depth first, the roots first.
const TREE: readonly BookmarkNode[] = [
    node(`bar`, `Bookmarks bar`, undefined),
    node(`b1`, `FRITZ!Box`, `bar`, `http://192.168.0.168/`, ICON),
    node(`f1`, `Work`, `bar`),
    node(`b2`, `Pull requests`, `f1`, `https://github.com/pulls`),
    node(`f2`, `Docs`, `f1`),
    node(`b3`, `Vue guide`, `f2`, `https://vuejs.org/guide/`),
    node(`b4`, `CI`, `bar`, `https://ci.example/`),
    node(`other`, `Other bookmarks`, undefined),
    node(`b5`, `Recipes`, `other`, `https://food.example/`),
];

describe("the star", () => {
    test("is filled for a page kept, a bare site's slash aside, and hollow for one not", () => {
        expect(bookmarkFor(TREE, `http://192.168.0.168`)?.id).toBe(`b1`);
        expect(bookmarkFor(TREE, `https://vuejs.org/guide/`)?.id).toBe(`b3`);
        expect(bookmarkFor(TREE, `https://vuejs.org/api/`)).toBeUndefined();
        expect(bookmarkFor(TREE, undefined)).toBeUndefined();
        expect(bookmarkFor(TREE, ``)).toBeUndefined();
    });

    test("shows only for a web page", () => {
        expect(bookmarkable(`https://example.com/`)).toBe(true);
        expect(bookmarkable(`http://192.168.0.168/`)).toBe(true);
        expect(bookmarkable(`about:blank`)).toBe(false);
        expect(bookmarkable(`chrome://settings`)).toBe(false);
        expect(bookmarkable(undefined)).toBe(false);
    });
});

describe("folders", () => {
    test("each folder's contents in their order; what is inside what", () => {
        expect(childrenOf(TREE, `bar`).map((kept) => kept.id)).toEqual([`b1`, `f1`, `b4`]);
        expect(isWithin(TREE, `b3`, `f1`)).toBe(true);
        expect(isWithin(TREE, `f1`, `f1`)).toBe(true);
        expect(isWithin(TREE, `b5`, `f1`)).toBe(false);
    });

    test("a bookmark can be filed in any folder, named by its path from the root", () => {
        expect(folderChoices(TREE, (root) => (root === `bar` ? `Bar` : `Other`))).toEqual([
            { id: `bar`, title: `Bar`, path: `Bar`, depth: 0 },
            { id: `f1`, title: `Work`, path: `Bar › Work`, depth: 1 },
            { id: `f2`, title: `Docs`, path: `Bar › Work › Docs`, depth: 2 },
            { id: `other`, title: `Other`, path: `Other`, depth: 0 },
        ]);
    });

    test("a row dropped on another lands just before it, counted without itself", () => {
        const ci = node(`b4`, `CI`, `bar`, `https://ci.example/`);
        const fritz = node(`b1`, `FRITZ!Box`, `bar`, `http://192.168.0.168/`, ICON);
        // Down the folder: FRITZ!Box (0) onto CI (2) lands at 1, before CI once FRITZ!Box has left.
        expect(dropIndex(TREE, `b1`, ci)).toBe(1);
        // Up the folder: CI onto FRITZ!Box lands first.
        expect(dropIndex(TREE, `b4`, fritz)).toBe(0);
        // From another folder: before CI, which is third.
        expect(dropIndex(TREE, `b5`, ci)).toBe(2);
    });
});

test("a move shows at once, depth first like the daemon's list, a folder carrying what it holds", () => {
    const ids = (nodes: readonly BookmarkNode[]): string => nodes.map((kept) => `${kept.parent ?? `-`}/${kept.id}`).join(` `);
    expect(ids(withMove(TREE, `b4`, `bar`, 0))).toBe(`-/bar bar/b4 bar/b1 bar/f1 f1/b2 f1/f2 f2/b3 -/other other/b5`);
    expect(ids(withMove(TREE, `f1`, `other`, 1))).toBe(`-/bar bar/b1 bar/b4 -/other other/b5 other/f1 f1/b2 f1/f2 f2/b3`);
    expect(withMove(TREE, `gone`, `bar`, 0)).toEqual([...TREE]);
});

test("the manager's search finds pages by every word, in the name or the address", () => {
    expect(searchBookmarks(TREE, `vue GUIDE`).map((kept) => kept.id)).toEqual([`b3`]);
    expect(searchBookmarks(TREE, `github`).map((kept) => kept.id)).toEqual([`b2`]);
    expect(searchBookmarks(TREE, `work`)).toEqual([]);
});

test("the address bar's marks: each bookmark's name and icon, and each site's icon, an open tab's winning", () => {
    const marks = pageMarks(TREE, [
        { id: `p1`, url: `https://www.github.com/intentic`, active: true, favicon: `data:image/png;base64,R0g=` },
        { id: `p2`, url: `http://192.168.0.168/net/home.lua`, active: false, favicon: `data:image/png;base64,TkVX` },
    ]);
    expect(marks.bookmarks.get(`http://192.168.0.168/`)).toEqual({ title: `FRITZ!Box`, favicon: ICON });
    expect(marks.bookmarks.size).toBe(5);
    expect(marks.icons.get(`github.com`)).toBe(`data:image/png;base64,R0g=`);
    expect(marks.icons.get(`192.168.0.168`)).toBe(`data:image/png;base64,TkVX`);
    expect(siteOf(`HTTPS://WWW.Example.com:8080/a?b`)).toBe(`example.com:8080`);
});

test("Ctrl, ⌘ or the middle button opens in a new tab", () => {
    expect(wantsNewTab({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(wantsNewTab({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(wantsNewTab({ ctrlKey: false, metaKey: false, button: 1 })).toBe(true);
    expect(wantsNewTab({ ctrlKey: false, metaKey: false, button: 0 })).toBe(false);
});
