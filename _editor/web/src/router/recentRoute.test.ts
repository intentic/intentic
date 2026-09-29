import "@intentic/testing/dom";
import { coldStartAtRoot, lastRoute, recentRoute, rememberRoute } from "./recentRoute";

it(`restores a recent route after a cold root launch`, () => {
    expect(recentRoute(JSON.stringify({ path: `/agents/picked`, at: 1000 }), 1000 + 29 * 60_000)).toBe(`/agents/picked`);
});

it(`ignores stale, root, and external destinations`, () => {
    expect(recentRoute(JSON.stringify({ path: `/agents/picked`, at: 1000 }), 1000 + 30 * 60_000)).toBeUndefined();
    expect(recentRoute(JSON.stringify({ path: `/`, at: 1000 }), 1001)).toBeUndefined();
    expect(recentRoute(JSON.stringify({ path: `//elsewhere.example`, at: 1000 }), 1001)).toBeUndefined();
    expect(recentRoute(`not json`, 1001)).toBeUndefined();
});

it(`reads back the page it was last on, for the next launch`, () => {
    rememberRoute(`/agents/sunny-lantern?panel=changes`, 5000);
    expect(lastRoute(5000 + 60_000)).toBe(`/agents/sunny-lantern?panel=changes`);
    expect(lastRoute(5000 + 31 * 60_000)).toBeUndefined();
});

// "/" redirects to a home page before the guard runs, so the guard reads the start URL off `redirectedFrom`.
it(`knows a cold start at "/" by where it was redirected from`, () => {
    expect(coldStartAtRoot({ fullPath: `/agents`, redirectedFrom: { fullPath: `/` } }, true)).toBe(true);
    expect(coldStartAtRoot({ fullPath: `/` }, true)).toBe(true);
    expect(coldStartAtRoot({ fullPath: `/agents` }, true)).toBe(false);
    expect(coldStartAtRoot({ fullPath: `/agents`, redirectedFrom: { fullPath: `/` } }, false)).toBe(false);
});
