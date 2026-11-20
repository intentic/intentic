import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookmarkNode } from "@intentic/sandbox-contract/schemas/bookmarks";
import { bookmarksDocument, bookmarksStore, type BookmarksStoreDeps } from "./bookmarks-store.js";
import { readChromiumBookmarks } from "./chromium-bookmarks.js";

// The store over a real temp workspace, seeded from a Bookmarks file laid out as Chromium writes it.

const NOW = 1_790_000_000_000;
const EPOCH_DELTA_MS = 11_644_473_600_000;
const chromiumTime = (ms: number): string => String(BigInt(ms + EPOCH_DELTA_MS) * 1000n);

// What Chromium writes: three roots, folders nested, times as microseconds since 1601 in strings, and its own pages.
const CHROMIUM_BOOKMARKS = {
    checksum: "0",
    roots: {
        bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            date_added: chromiumTime(NOW - 9000),
            children: [
                { type: "url", name: "FRITZ!Box", url: "http://192.168.0.168/", date_added: chromiumTime(NOW - 5000), guid: "g1", id: "5" },
                {
                    type: "folder",
                    name: "Work",
                    date_added: chromiumTime(NOW - 4000),
                    children: [{ type: "url", name: "Pull requests", url: "https://github.com/pulls", date_added: chromiumTime(NOW - 3000) }],
                },
                { type: "url", name: "Settings", url: "chrome://settings/", date_added: chromiumTime(NOW - 2000) },
            ],
        },
        other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "Docs", url: "https://docs.example/", date_added: "0" }] },
        synced: { type: "folder", name: "Mobile bookmarks", children: [{ type: "url", name: "Phone", url: "https://m.example/" }] },
    },
    version: 1,
};

let root: string;
let profileDir: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bookmarks-store-test-"));
    profileDir = join(root, "profile");
    await mkdir(join(profileDir, "Default"), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const minter = () => {
    let next = 0;
    return () => {
        next += 1;
        return `n${next}`;
    };
};

const titled = (nodes: readonly BookmarkNode[]): string[] => nodes.map((node) => `${node.parent ?? "-"}/${node.title}`);

test("Chromium's bookmarks are read as they are kept: folders, order, times, and nothing of Chromium's own pages", async () => {
    await writeFile(join(profileDir, "Default", "Bookmarks"), JSON.stringify(CHROMIUM_BOOKMARKS));
    const nodes = await readChromiumBookmarks(profileDir, NOW, minter());
    expect(nodes).toEqual([
        { id: "n1", kind: "url", title: "FRITZ!Box", url: "http://192.168.0.168/", parent: "bar", added: NOW - 5000 },
        { id: "n2", kind: "folder", title: "Work", parent: "bar", added: NOW - 4000 },
        { id: "n3", kind: "url", title: "Pull requests", url: "https://github.com/pulls", parent: "n2", added: NOW - 3000 },
        // No time given: now.
        { id: "n4", kind: "url", title: "Docs", url: "https://docs.example/", parent: "other", added: NOW },
        { id: "n5", kind: "folder", title: "Mobile bookmarks", parent: "other", added: NOW },
        { id: "n6", kind: "url", title: "Phone", url: "https://m.example/", parent: "n5", added: NOW },
    ]);
    expect(await readChromiumBookmarks(join(root, "absent"), NOW, minter())).toBeUndefined();
});

test("a profile is seeded once, its changes are saved and announced, and a restart reads them back", async () => {
    await writeFile(join(profileDir, "Default", "Bookmarks"), JSON.stringify(CHROMIUM_BOOKMARKS));
    const changed: string[] = [];
    let seeds = 0;
    const deps = (mint: () => string): BookmarksStoreDeps => ({
        root,
        chromiumBookmarks: async (_profile, minting) => {
            seeds += 1;
            return readChromiumBookmarks(profileDir, NOW, minting);
        },
        changed: (profile) => changed.push(profile),
        warn: () => {},
        now: () => NOW,
        mint,
    });
    const store = bookmarksStore(deps(minter()));
    const added = await store.add({ profile: "_own", kind: "url", title: "Vue", url: "https://vuejs.org/", favicon: "data:image/png;base64,AA==" });
    expect(added).toEqual({ id: "n7", kind: "url", title: "Vue", url: "https://vuejs.org/", parent: "bar", added: NOW, favicon: "data:image/png;base64,AA==" });
    await store.move({ profile: "_own", id: "n7", parent: "n2", index: 0 });
    await store.remove("_own", "n1");
    expect(changed).toEqual(["_own", "_own", "_own"]);

    // Seeded again from nothing new: the second store reads the file, not Chromium's.
    const restarted = bookmarksStore(deps(() => "never"));
    const { nodes } = await restarted.list("_own");
    expect(titled(nodes)).toEqual([
        "-/Bookmarks bar",
        "bar/Work",
        "n2/Vue",
        "n2/Pull requests",
        "-/Other bookmarks",
        "other/Docs",
        "other/Mobile bookmarks",
        "n5/Phone",
    ]);
    expect(seeds).toBe(1);
    expect(await readdir(join(root, bookmarksDocument.path))).toEqual(["p-_own.json"]);
});

test("profiles keep their own trees; a Bookmarks file Chromium was halfway through writing is tried again next start", async () => {
    await writeFile(join(profileDir, "Default", "Bookmarks"), `{"roots": {"bookmark_bar": {"type": "folder", "children": [`);
    const problems: string[] = [];
    const deps: BookmarksStoreDeps = {
        root,
        chromiumBookmarks: (_profile, mint) => readChromiumBookmarks(profileDir, NOW, mint),
        changed: () => {},
        warn: (problem, message) => problems.push(`${message}: ${problem.profile}`),
        now: () => NOW,
    };
    const store = bookmarksStore(deps);
    expect((await store.list("_own")).nodes.map((node) => node.id)).toEqual(["bar", "other"]);
    expect(problems).toEqual(["bookmarks: could not read Chromium's own bookmarks: _own"]);
    await store.add({ profile: "web", kind: "url", title: "Agent's", url: "https://agent.example/" });
    expect((await store.list("_own")).nodes).toHaveLength(2);

    await writeFile(join(profileDir, "Default", "Bookmarks"), JSON.stringify(CHROMIUM_BOOKMARKS));
    expect((await bookmarksStore(deps).list("_own")).nodes).toHaveLength(8);
});

test("a refused change is told to its caller and leaves the tree and the next change alone", async () => {
    const store = bookmarksStore({ root, chromiumBookmarks: async () => undefined, changed: () => {}, warn: () => {}, now: () => NOW, mint: minter() });
    await expect(store.move({ profile: "_own", id: "bar", parent: "other", index: 0 })).rejects.toThrow("keep their place");
    await expect(store.add({ profile: "_own", kind: "url", title: "Ok", url: "https://ok.example/" })).resolves.toMatchObject({ parent: "bar" });
});
