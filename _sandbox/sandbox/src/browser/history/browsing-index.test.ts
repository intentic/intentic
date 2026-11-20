import { BrowsingIndex, frecencyOf, MAX_ENTRIES, rememberable, searchTermOf } from "./browsing-index.js";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

test("a page visited twice counts two visits, a typed one apart, with the title it arrived with", () => {
    const index = new BrowsingIndex();
    index.visit("http://192.168.0.168/", "typed", NOW - 1000, "Router");
    index.visit("http://192.168.0.168/", "link", NOW);
    const [entry] = index.read(undefined, NOW).entries;
    expect(entry).toEqual({ url: "http://192.168.0.168/", title: "Router", visits: 2, typed: 1, last: NOW, frecency: 300 });
});

test("a reload and the first leg of a redirect are no visit, though a reload may still bring a title", () => {
    const index = new BrowsingIndex();
    expect(index.visit("https://example.com/", "reload", NOW)).toBe(false);
    index.visit("https://example.com/", "link", NOW);
    expect(index.visit("https://example.com/", "redirect", NOW, "Example Domain")).toBe(true);
    expect(index.read(undefined, NOW).entries).toEqual([{ url: "https://example.com/", title: "Example Domain", visits: 1, typed: 0, last: NOW, frecency: 100 }]);
});

test("only web pages are remembered", () => {
    expect(rememberable("https://example.com/")).toBe(true);
    expect(rememberable("about:blank")).toBe(false);
    expect(rememberable("chrome-error://chromewebdata/")).toBe(false);
    expect(rememberable("file:///etc/passwd")).toBe(false);
    const index = new BrowsingIndex();
    expect(index.visit("about:blank", "typed", NOW)).toBe(false);
    expect(index.size).toBe(0);
});

test("frecency: a typed visit counts double, and a visit's worth falls with its age", () => {
    expect(frecencyOf({ visits: 1, recent: [{ at: NOW }] }, NOW)).toBe(100);
    expect(frecencyOf({ visits: 1, recent: [{ at: NOW, typed: true }] }, NOW)).toBe(200);
    expect(frecencyOf({ visits: 1, recent: [{ at: NOW - 10 * DAY }] }, NOW)).toBe(70);
    expect(frecencyOf({ visits: 1, recent: [{ at: NOW - 400 * DAY }] }, NOW)).toBe(10);
    // Many visits, of which only the newest are held one by one: the count scales their average.
    expect(frecencyOf({ visits: 20, recent: [{ at: NOW }, { at: NOW - 20 * DAY }] }, NOW)).toBe(1500);
    // Taken in from Chromium with no visit of its own: the count alone, at the oldest worth.
    expect(frecencyOf({ visits: 3, recent: [] }, NOW)).toBe(30);
});

test("a full answer is best first; one past a cursor holds only what changed since", () => {
    const index = new BrowsingIndex();
    index.visit("https://a.example/", "link", NOW - 40 * DAY);
    index.visit("https://b.example/", "typed", NOW);
    const first = index.read(undefined, NOW);
    expect(first.full).toBe(true);
    expect(first.entries.map((entry) => entry.url)).toEqual(["https://b.example/", "https://a.example/"]);

    index.retitle("https://a.example/", "A");
    index.visit("https://c.example/", "link", NOW);
    index.forget({ kind: "urls", urls: ["https://b.example/"] });
    const delta = index.read(first.cursor, NOW);
    expect(delta.full).toBe(false);
    expect(delta.entries.map((entry) => entry.url).toSorted()).toEqual(["https://a.example/", "https://c.example/"]);
    expect(delta.removed).toEqual(["https://b.example/"]);

    // Nothing since: an empty delta, at the same cursor.
    const quiet = index.read(delta.cursor, NOW);
    expect(quiet).toEqual({ cursor: delta.cursor, full: false, entries: [], removed: [], terms: [] });
});

test("a cursor from another generation (a restart, a forgotten stretch) is answered whole", () => {
    const index = new BrowsingIndex();
    index.visit("https://a.example/", "link", NOW);
    const before = index.read(undefined, NOW).cursor;
    expect(new BrowsingIndex().read(before, NOW).full).toBe(true);
    index.forget({ kind: "range", from: NOW - DAY, to: NOW + 1 });
    expect(index.read(before, NOW).full).toBe(true);
    expect(index.read("garbage", NOW).full).toBe(true);
});

test("forgetting a stretch drops the visits in it, and a page whose every held visit was inside", () => {
    const index = new BrowsingIndex();
    index.visit("https://kept.example/", "typed", NOW - 3 * DAY);
    index.visit("https://kept.example/", "link", NOW - 1000);
    index.visit("https://gone.example/", "link", NOW - 2000);
    index.visit("https://older.example/", "link", NOW - 5 * DAY);
    expect(index.forget({ kind: "range", from: NOW - DAY, to: NOW })).toBe(1);
    const { entries } = index.read(undefined, NOW);
    expect(entries.map((entry) => entry.url).toSorted()).toEqual(["https://kept.example/", "https://older.example/"]);
    expect(entries.find((entry) => entry.url === "https://kept.example/")).toMatchObject({ visits: 1, typed: 1, last: NOW - 3 * DAY });
});

test("forgetting everything empties pages and searches", () => {
    const index = new BrowsingIndex();
    index.visit("https://search.brave.com/search?q=router+login", "typed", NOW);
    expect(index.forget({ kind: "all" })).toBe(1);
    expect(index.read(undefined, NOW)).toMatchObject({ entries: [], terms: [] });
});

test("a results page of one of the address bar's engines is remembered as a search", () => {
    expect(searchTermOf("https://search.brave.com/search?q=vue+router")).toBe("vue router");
    expect(searchTermOf("https://www.google.com/search?q=intentic&hl=en")).toBe("intentic");
    expect(searchTermOf("https://google.com/search?q=bare")).toBe("bare");
    expect(searchTermOf("https://duckduckgo.com/?q=ddg")).toBe("ddg");
    expect(searchTermOf("https://example.com/?q=not-an-engine")).toBe(undefined);
    const index = new BrowsingIndex();
    index.visit("https://search.brave.com/search?q=Vue+Router", "typed", NOW - 10);
    index.visit("https://search.brave.com/search?q=vue+router&page=2", "link", NOW);
    expect(index.read(undefined, NOW).terms).toEqual([{ term: "Vue Router", count: 2, last: NOW }]);
});

test("Chromium's record seeds what the index does not know, and never overrides what it does", () => {
    const index = new BrowsingIndex();
    index.visit("https://x.com/", "link", NOW, "X");
    index.seed(
        [
            { url: "https://x.com/", title: "Old X", visits: 9, typed: 4, last: NOW - DAY, recent: [] },
            { url: "http://192.168.0.168/", title: undefined, visits: 3, typed: 3, last: NOW - DAY, recent: [{ at: NOW - DAY, typed: true }] },
            { url: "chrome://settings/", title: "Settings", visits: 1, typed: 1, last: NOW, recent: [] },
        ],
        [{ term: "fritzbox", last: NOW - DAY }],
    );
    expect(index.seeded).toBe(true);
    const { entries, terms } = index.read(undefined, NOW);
    expect(entries).toEqual([
        { url: "http://192.168.0.168/", visits: 3, typed: 3, last: NOW - DAY, frecency: 600 },
        { url: "https://x.com/", title: "X", visits: 1, typed: 0, last: NOW, frecency: 100 },
    ]);
    expect(terms).toEqual([{ term: "fritzbox", count: 1, last: NOW - DAY }]);
});

test("past the ceiling the page least worth suggesting goes, and says so to a caller catching up", () => {
    const index = new BrowsingIndex();
    index.seed(
        Array.from({ length: MAX_ENTRIES }, (_, n) => ({ url: `https://site${n}.example/`, title: undefined, visits: 2, typed: 0, last: NOW, recent: [] })),
        [],
    );
    index.seed([{ url: "https://worst.example/", title: undefined, visits: 1, typed: 0, last: NOW - DAY, recent: [] }], []);
    expect(index.size).toBe(MAX_ENTRIES);
    expect(index.read(undefined, NOW, MAX_ENTRIES).entries.some((entry) => entry.url === "https://worst.example/")).toBe(false);
});

test("what is saved loads back the same", () => {
    const index = new BrowsingIndex();
    index.visit("https://a.example/", "typed", NOW, "A");
    index.visit("https://search.brave.com/search?q=a", "link", NOW);
    index.seeded = true;
    const reloaded = new BrowsingIndex(index.toFile());
    expect(reloaded.seeded).toBe(true);
    expect(reloaded.read(undefined, NOW)).toMatchObject({ entries: index.read(undefined, NOW).entries, terms: index.read(undefined, NOW).terms });
});
