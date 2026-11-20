import { BookmarkRefusal, BookmarkTree } from "./bookmark-tree.js";

const NOW = 1_790_000_000_000;

// Ids in the order they are minted, so a test can name what it made.
const minter = () => {
    let next = 0;
    return () => {
        next += 1;
        return `n${next}`;
    };
};

// Each folder's contents as titles, depth first, for reading a tree at a glance: "bar: A, F[B, C] | other: D".
const folders = (tree: BookmarkTree): string => {
    const nodes = tree.list();
    const inside = (parent: string): string =>
        nodes
            .filter((node) => node.parent === parent)
            .map((node) => (node.kind === "folder" ? `${node.title}[${inside(node.id)}]` : node.title))
            .join(", ");
    return `bar: ${inside("bar")} | other: ${inside("other")}`;
};

const filled = (): BookmarkTree => {
    const tree = new BookmarkTree([], NOW);
    const mint = minter();
    tree.add({ kind: "url", title: "Router", url: "http://192.168.0.168/" }, NOW, mint);
    tree.add({ kind: "folder", title: "Work" }, NOW, mint);
    tree.add({ kind: "url", title: "PRs", url: "https://github.com/pulls", parent: "n2" }, NOW, mint);
    tree.add({ kind: "url", title: "CI", url: "https://ci.example/", parent: "n2" }, NOW, mint);
    tree.add({ kind: "url", title: "Docs", url: "https://docs.example/", parent: "other" }, NOW, mint);
    return tree;
};

test("a new tree has its two roots and nothing in them; adding goes to the bar, last, unless told", () => {
    const tree = new BookmarkTree([], NOW);
    expect(tree.list()).toEqual([
        { id: "bar", kind: "folder", title: "Bookmarks bar", added: NOW },
        { id: "other", kind: "folder", title: "Other bookmarks", added: NOW },
    ]);
    const tidy = filled();
    expect(folders(tidy)).toBe("bar: Router, Work[PRs, CI] | other: Docs");
    tidy.add({ kind: "url", title: "First", url: "https://first.example/", index: 0 }, NOW, () => "x");
    expect(folders(tidy)).toBe("bar: First, Router, Work[PRs, CI] | other: Docs");
    expect(tidy.get("x")).toEqual({ id: "x", kind: "url", title: "First", url: "https://first.example/", parent: "bar", added: NOW });
});

test("moves reorder within a folder and carry a folder, contents and all, to another", () => {
    const tree = filled();
    tree.move("n4", "n2", 0);
    expect(folders(tree)).toBe("bar: Router, Work[CI, PRs] | other: Docs");
    tree.move("n2", "other", 0);
    expect(folders(tree)).toBe("bar: Router | other: Work[CI, PRs], Docs");
    // Past the end is the end.
    tree.move("n1", "other", 99);
    expect(folders(tree)).toBe("bar:  | other: Work[CI, PRs], Docs, Router");
});

test("edits rename, readdress and refile; a folder takes no address", () => {
    const tree = filled();
    expect(tree.edit("n1", { title: "FRITZ!Box", url: "http://fritz.box/" })).toMatchObject({ title: "FRITZ!Box", url: "http://fritz.box/" });
    tree.edit("n5", { parent: "n2" });
    expect(folders(tree)).toBe("bar: FRITZ!Box, Work[PRs, CI, Docs] | other: ");
    expect(tree.edit("n2", { url: "https://nowhere.example/" }).url).toBeUndefined();
});

test("a folder goes with everything in it; what is gone already is nothing to remove", () => {
    const tree = filled();
    expect(tree.remove("n2")).toBe(true);
    expect(folders(tree)).toBe("bar: Router | other: Docs");
    expect(tree.get("n3")).toBeUndefined();
    expect(tree.remove("n2")).toBe(false);
    expect(tree.size).toBe(2);
});

test("refused: a folder into itself, a root moved or removed, a page with no address, a folder that is not there", () => {
    const tree = filled();
    tree.add({ kind: "folder", title: "Inner", parent: "n2" }, NOW, () => "inner");
    const refusal = (run: () => void): { message: string; missing: boolean } | undefined => {
        try {
            run();
            return undefined;
        } catch (err) {
            return err instanceof BookmarkRefusal ? { message: err.message, missing: err.missing } : undefined;
        }
    };
    expect(refusal(() => void tree.move("n2", "inner", 0))).toEqual({ message: "a folder cannot go inside itself", missing: false });
    expect(refusal(() => void tree.move("n2", "n2", 0))?.message).toBe("a folder cannot go inside itself");
    expect(refusal(() => void tree.move("bar", "other", 0))?.missing).toBe(false);
    expect(refusal(() => void tree.remove("other"))?.missing).toBe(false);
    expect(refusal(() => void tree.add({ kind: "url", title: "No address" }, NOW))?.message).toBe("a bookmark needs an address");
    expect(refusal(() => void tree.add({ kind: "url", title: "x", url: "https://x/", parent: "gone" }, NOW))).toEqual({ message: "there is no folder gone", missing: true });
    expect(refusal(() => void tree.add({ kind: "url", title: "x", url: "https://x/", parent: "n1" }, NOW))).toEqual({ message: "n1 is a bookmark, not a folder", missing: false });
    expect(refusal(() => void tree.edit("gone", { title: "x" }))?.missing).toBe(true);
});

test("what is saved loads back the same, and a node whose folder is gone lands in the other bookmarks", () => {
    const tree = filled();
    expect(new BookmarkTree(tree.list(), NOW).list()).toEqual(tree.list());
    const orphaned = new BookmarkTree([{ id: "lost", kind: "url", title: "Lost", url: "https://lost.example/", parent: "deleted", added: NOW }], NOW);
    expect(orphaned.get("lost")?.parent).toBe("other");
});
