import type { BrowsingEntry, BrowsingTerm } from "@intentic/sandbox-contract/schemas/browsing";
import { pageMarks } from "../bookmarks/bookmarkTree";
import { inlineCompletion, markHistory, type OmniboxQuery, type OmniboxRow, prepareHistory, rankOmnibox, segmentsOf, shownAddress } from "./rank";

const NOW = 1_790_000_000_000;

const page = (url: string, frecency: number, extra: Partial<BrowsingEntry> = {}): BrowsingEntry => ({
    url,
    visits: 1,
    typed: 0,
    last: NOW,
    frecency,
    ...extra,
});

const HISTORY = prepareHistory([
    page(`http://192.168.0.168/`, 600, { title: `FRITZ!Box`, typed: 3 }),
    page(`http://192.168.0.168/net/home.lua`, 80, { title: `Home network` }),
    page(`https://github.com/`, 900, { title: `GitHub` }),
    page(`https://github.com/intentic/intentic/pulls`, 500, { title: `Pull requests · intentic/intentic` }),
    page(`https://gist.github.com/radar/abc`, 50, { title: `A gist` }),
    page(`https://www.google.com/`, 700, { title: `Google` }),
    page(`https://docs.example.com/guide/install`, 40, { title: `Installing the CLI` }),
    page(`https://vuejs.org/guide/introduction.html`, 300, { title: `Introduction | Vue.js` }),
]);

const query = (text: string, more: Partial<OmniboxQuery> = {}): OmniboxQuery => ({
    text,
    history: HISTORY,
    tabs: [],
    terms: [],
    remote: [],
    engine: `brave`,
    complete: true,
    ...more,
});

const kinds = (rows: readonly OmniboxRow[]): string[] =>
    rows.map((row) => `${row.kind} ${`url` in row ? row.url : `tab` in row ? row.tab.url : ``}`.trim());

describe("inline completion", () => {
    test("a host's first digits complete to the host visited, the rest selected", () => {
        expect(inlineCompletion(`192`, HISTORY)).toEqual({ text: `192.168.0.168`, url: `http://192.168.0.168/` });
        expect(inlineCompletion(`192.168.0.1`, HISTORY)).toEqual({ text: `192.168.0.168`, url: `http://192.168.0.168/` });
    });

    test("the typed part stays as typed, and the site most worth it wins", () => {
        expect(inlineCompletion(`GI`, HISTORY)).toEqual({ text: `GIthub.com`, url: `https://github.com/` });
        // `www.` typed keeps it; left out, the site completes without it.
        expect(inlineCompletion(`goo`, HISTORY)).toEqual({ text: `google.com`, url: `https://www.google.com/` });
        expect(inlineCompletion(`www.g`, HISTORY)).toEqual({ text: `www.google.com`, url: `https://www.google.com/` });
    });

    test("once a path is typed, the best page under it", () => {
        expect(inlineCompletion(`github.com/in`, HISTORY)).toEqual({
            text: `github.com/intentic/intentic/pulls`,
            url: `https://github.com/intentic/intentic/pulls`,
        });
    });

    test("a site visited once, deep, completes to that page; never visited at its root but often, to the site", () => {
        expect(inlineCompletion(`docs`, HISTORY)).toEqual({ text: `docs.example.com/guide/install`, url: `https://docs.example.com/guide/install` });
        const twice = prepareHistory([page(`https://shop.example/a`, 10), page(`https://shop.example/b`, 20)]);
        expect(inlineCompletion(`sho`, twice)).toEqual({ text: `shop.example`, url: `https://shop.example/` });
    });

    test("nothing to complete: a space, a scheme, no page, or the whole address already typed", () => {
        expect(inlineCompletion(`192 168`, HISTORY)).toBeUndefined();
        expect(inlineCompletion(`https://gi`, HISTORY)).toBeUndefined();
        expect(inlineCompletion(`zzz`, HISTORY)).toBeUndefined();
        expect(inlineCompletion(`github.com`, HISTORY)).toBeUndefined();
        expect(inlineCompletion(``, HISTORY)).toBeUndefined();
    });
});

describe("ranking", () => {
    test("the owner's case: 192 completes inline, and Enter goes to the router", () => {
        const result = rankOmnibox(query(`192`));
        expect(result.inline).toEqual({ text: `192.168.0.168`, url: `http://192.168.0.168/` });
        expect(kinds(result.rows)).toEqual([
            `history http://192.168.0.168/`,
            `history http://192.168.0.168/net/home.lua`,
            `search https://search.brave.com/search?q=192`,
        ]);
        expect(result.rows[0]?.fill).toBe(`192.168.0.168`);
    });

    test("right after a deletion nothing completes, and the default is what was typed", () => {
        const result = rankOmnibox(query(`192`, { complete: false }));
        expect(result.inline).toBeUndefined();
        expect(kinds(result.rows)[0]).toBe(`search https://search.brave.com/search?q=192`);
    });

    test("a word matches a page by its address parts and its title, best match first", () => {
        const result = rankOmnibox(query(`pull`, { complete: false }));
        expect(kinds(result.rows)).toEqual([`search https://search.brave.com/search?q=pull`, `history https://github.com/intentic/intentic/pulls`]);
        const row = result.rows[1];
        expect(row?.kind === `history` ? row.title : []).toEqual([
            { text: `Pull`, match: true },
            { text: ` requests · intentic/intentic`, match: false },
        ]);
    });

    test("an address typed whole is the default, with the search for it offered after", () => {
        const result = rankOmnibox(query(`example.org/new`));
        expect(kinds(result.rows)).toEqual([`address https://example.org/new`, `search https://search.brave.com/search?q=example.org%2Fnew`]);
    });

    test("an address typed whole that history knows is that page, not a second row beside it", () => {
        const result = rankOmnibox(query(`github.com`));
        expect(kinds(result.rows)).toEqual([
            `history https://github.com/`,
            `history https://github.com/intentic/intentic/pulls`,
            `history https://gist.github.com/radar/abc`,
            `search https://search.brave.com/search?q=github.com`,
        ]);
        expect(result.rows[0]?.fill).toBe(`github.com`);
    });

    test("a keyword searches its site; the engine's own search follows", () => {
        const result = rankOmnibox(query(`yt lofi beats`));
        expect(kinds(result.rows)).toEqual([
            `keyword https://www.youtube.com/results?search_query=lofi%20beats`,
            `search https://search.brave.com/search?q=yt%20lofi%20beats`,
        ]);
    });

    test("an open tab is offered to switch to, in place of its page in history", () => {
        const tabs = [{ session: `browser-own`, pageId: `p2`, url: `https://vuejs.org/guide/introduction.html`, title: `Introduction | Vue.js` }];
        const result = rankOmnibox(query(`vue`, { tabs, complete: false }));
        expect(kinds(result.rows)).toEqual([`search https://search.brave.com/search?q=vue`, `tab https://vuejs.org/guide/introduction.html`]);
    });

    test("past searches, then the engine's suggestions, none repeated", () => {
        const terms: BrowsingTerm[] = [
            { term: `router login`, count: 2, last: NOW },
            { term: `vue router`, count: 1, last: NOW },
        ];
        const result = rankOmnibox(query(`router`, { terms, remote: [`router`, `router login`, `router table`], engine: `google`, complete: false }));
        expect(kinds(result.rows)).toEqual([
            `search https://www.google.com/search?q=router`,
            `suggestion https://www.google.com/search?q=router%20login`,
            `suggestion https://www.google.com/search?q=router%20table`,
        ]);
        expect(result.rows.map((row) => (row.kind === `suggestion` ? row.past : undefined))).toEqual([undefined, true, false]);
    });

    test("with nothing typed, the pages most worth going back to", () => {
        expect(kinds(rankOmnibox(query(``)).rows)).toEqual([
            `history https://github.com/`,
            `history https://www.google.com/`,
            `history http://192.168.0.168/`,
            `history https://github.com/intentic/intentic/pulls`,
            `history https://vuejs.org/guide/introduction.html`,
            `history http://192.168.0.168/net/home.lua`,
        ]);
    });

    test("a search's history is only what matched it well", () => {
        // `stal` is inside "install", mid-word: fine for an address being typed, noise under a search.
        expect(kinds(rankOmnibox(query(`stal`, { complete: false })).rows)).toEqual([`search https://search.brave.com/search?q=stal`]);
    });
});

describe("bookmarks", () => {
    const ICON = `data:image/png;base64,QUFB`;
    const marks = pageMarks(
        [
            { id: `bar`, kind: `folder`, title: `Bookmarks bar`, added: NOW },
            { id: `b1`, kind: `url`, title: `Stripe dashboard`, url: `https://dashboard.stripe.com/`, parent: `bar`, added: NOW, favicon: ICON },
            { id: `b2`, kind: `url`, title: `Vue guide`, url: `https://vuejs.org/guide/introduction.html`, parent: `bar`, added: NOW },
        ],
        [{ id: `p1`, url: `https://github.com/intentic`, active: true, favicon: `data:image/png;base64,R0g=` }],
    );
    const marked = markHistory(HISTORY, marks);

    test("a bookmark never visited is found, under its own name and icon, and completes inline", () => {
        const result = rankOmnibox(query(`dash`, { history: marked }));
        expect(result.inline).toEqual({ text: `dashboard.stripe.com`, url: `https://dashboard.stripe.com/` });
        expect(result.rows[0]).toMatchObject({ kind: `history`, url: `https://dashboard.stripe.com/`, bookmarked: true, favicon: ICON, fill: `dashboard.stripe.com` });
    });

    test("a bookmarked page ranks above plain history at an equal match", () => {
        // Both match "guide" in their address, at the start of a part of it; the plain page is visited far more.
        const equal = prepareHistory([page(`https://docs.example.com/guide/a`, 20_000, { title: `A` }), page(`https://vuejs.org/guide/introduction.html`, 3, { title: `B` })]);
        const rows = rankOmnibox(query(`guide`, { history: markHistory(equal, marks), complete: false })).rows;
        expect(kinds(rows)).toEqual([
            `search https://search.brave.com/search?q=guide`,
            `history https://vuejs.org/guide/introduction.html`,
            `history https://docs.example.com/guide/a`,
        ]);
        // Unmarked, the order is the history's own.
        expect(kinds(rankOmnibox(query(`guide`, { history: equal, complete: false })).rows)[1]).toBe(`history https://docs.example.com/guide/a`);
    });

    test("a page gets its site's icon from an open tab, and keeps its own title over the bookmark's", () => {
        const github = marked.find((prepared) => prepared.entry.url === `https://github.com/intentic/intentic/pulls`);
        expect(github?.favicon).toBe(`data:image/png;base64,R0g=`);
        expect(github?.bookmarked).toBe(false);
        const vue = marked.find((prepared) => prepared.entry.url === `https://vuejs.org/guide/introduction.html`);
        expect(vue?.entry.title).toBe(`Introduction | Vue.js`);
        expect(vue?.bookmarked).toBe(true);
        expect(marked).toHaveLength(HISTORY.length + 1);
    });
});

describe("shown text", () => {
    test("an address loses its scheme and a bare root's slash, and is decoded", () => {
        expect(shownAddress(`https://github.com/`)).toBe(`github.com`);
        expect(shownAddress(`https://pl.wikipedia.org/wiki/Gda%C5%84sk`)).toBe(`pl.wikipedia.org/wiki/Gdańsk`);
        expect(shownAddress(`https://example.com/a/`)).toBe(`example.com/a/`);
        expect(shownAddress(`https://example.com/%E0%A4%A`)).toBe(`example.com/%E0%A4%A`);
    });

    test("matches are marked, case aside", () => {
        expect(segmentsOf(`GitHub`, [`git`])).toEqual([
            { text: `Git`, match: true },
            { text: `Hub`, match: false },
        ]);
        expect(segmentsOf(`abc`, [])).toEqual([{ text: `abc`, match: false }]);
    });
});

// The budget: a keystroke's ranking inside one frame (16 ms) with the most a full answer ships, 5,000 pages. Measured
// as the median of every keystroke of a typed address and a typed search, so one slow tick on a busy machine is not
// what is judged; on an idle machine each takes about a millisecond.
describe("speed", () => {
    const words = [`router`, `vue`, `github`, `docs`, `install`, `settings`, `login`, `blog`, `news`, `shop`, `cloud`, `mail`];
    const many = prepareHistory(
        Array.from({ length: 5000 }, (_, n) =>
            page(`https://${words[n % words.length]}${n}.example.com/${words[(n * 7) % words.length]}/${n}?ref=${n % 13}`, (n * 37) % 1000, {
                title: `${words[(n * 3) % words.length]} page ${n} about ${words[(n * 5) % words.length]}`,
                typed: n % 9 === 0 ? 1 : 0,
            }),
        ),
    );

    test("5,000 pages rank inside a frame per keystroke", () => {
        const timings: number[] = [];
        for (const typed of [`github.com/settings`, `vue router login`]) {
            for (let length = 1; length <= typed.length; length += 1) {
                const started = performance.now();
                const result = rankOmnibox({ ...query(typed.slice(0, length)), history: many });
                timings.push(performance.now() - started);
                expect(result.rows.length).toBeGreaterThan(0);
            }
        }
        const median = timings.toSorted((left, right) => left - right)[Math.floor(timings.length / 2)] ?? Number.POSITIVE_INFINITY;
        expect(median).toBeLessThan(16);
    });
});
