// jsdom: the kit's one stale-chunk recovery. Every lazy chunk in the editor goes through `loadChunk` (views, the
// shell, extension views, Monaco, mermaid, the highlighter), so these are the rules all of them follow.
import "@intentic/testing/dom";
import { takeReloadReason } from "@intentic/ui/reload-reason";
import { installChunkRecovery, isStaleChunkError, loadChunk } from "@intentic/ui/chunk";

// window.location is unforgeable in jsdom; the reload is observed through a replaced global, read at call time.
const assign = jest.fn();
beforeAll(() => {
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: { assign, href: `http://localhost/files?path=a`, origin: `http://localhost`, pathname: `/files`, search: `?path=a` },
    });
});
beforeEach(() => {
    sessionStorage.clear();
    assign.mockClear();
});

const deadChunk = new TypeError(`Failed to fetch dynamically imported module: /deps/mermaid.js?v=stale`);
const dead = (): Promise<never> => Promise.reject(deadChunk);

// Drains the microtasks a settled `loadChunk` would have used, without timers.
const settle = async (): Promise<void> => {
    for (let beat = 0; beat < 4; beat += 1) {
        await Promise.resolve();
    }
};

const outcome = async (pending: Promise<unknown>): Promise<string> => {
    let seen = `pending`;
    pending.then(
        () => (seen = `resolved`),
        () => (seen = `rejected`),
    );
    await settle();
    return seen;
};

it(`answers a dead chunk with one reload onto the page the reader is on, and never settles while it goes`, async () => {
    expect(await outcome(loadChunk(dead))).toBe(`pending`);
    expect(assign.mock.calls).toEqual([[`/files?path=a`]]);
});

// Analytics reads this note on the next load to tell a reload the app forced from one the reader did (reloadReason.ts).
it(`leaves a note that the reload it starts was a dead chunk's`, async () => {
    await outcome(loadChunk(dead));
    expect(takeReloadReason()).toBe(`stale-chunk`);
    expect(takeReloadReason()).toBeUndefined();
});

it(`reloads onto the target it is given instead, once: the second dead load rejects as it came`, async () => {
    expect(await outcome(loadChunk(dead, `/demo/target`))).toBe(`pending`);
    await expect(loadChunk(dead, `/demo/target`)).rejects.toBe(deadChunk);
    expect(assign.mock.calls).toEqual([[`/demo/target`]]);
});

it(`rejects any other failure without reloading: reloading a coding bug would loop, not recover`, async () => {
    const bug = new TypeError(`Cannot read properties of undefined (reading 'foo')`);
    await expect(loadChunk(() => Promise.reject(bug))).rejects.toBe(bug);
    expect(assign.mock.calls).toEqual([]);
});

// 2026-10-27: an edge cached a 404 for one chunk of the /sandbox view. The shell's own chunk loaded on every load and
// re-armed the reload, so the view's failed preload reloaded the page about once a second, forever.
it(`a chunk that loads does not re-arm the reload: a chunk still missing after it fails instead of looping`, async () => {
    expect(await outcome(loadChunk(dead))).toBe(`pending`);
    expect(await loadChunk(() => Promise.resolve(42))).toBe(42);
    await expect(loadChunk(dead)).rejects.toBe(deadChunk);
    expect(assign.mock.calls).toEqual([[`/files?path=a`]]);
});

it(`gives the same page its reload back once a few minutes have passed, for the next redeploy`, async () => {
    const now = jest.spyOn(Date, `now`).mockReturnValue(1_000_000);
    try {
        expect(await outcome(loadChunk(dead))).toBe(`pending`);
        now.mockReturnValue(1_000_000 + 4 * 60_000);
        await expect(loadChunk(dead)).rejects.toBe(deadChunk);
        now.mockReturnValue(1_000_000 + 6 * 60_000);
        expect(await outcome(loadChunk(dead))).toBe(`pending`);
        expect(assign.mock.calls).toEqual([[`/files?path=a`], [`/files?path=a`]]);
    } finally {
        now.mockRestore();
    }
});

// A 404 the browser itself kept would answer the reload too: the files the page was refused are asked for again past the
// cache first, and only this origin's scripts and stylesheets.
it(`asks the server again, past the browser's cache, for the files the page was refused before it reloads`, async () => {
    // A Resource Timing entry as the browser reports one: only the two fields the recovery reads.
    const refused = (name: string, responseStatus: number): PerformanceEntry => Object.assign(Object.create(null), { name, responseStatus });
    const entries = jest
        .spyOn(performance, `getEntriesByType`)
        .mockReturnValue([
            refused(`http://localhost/assets/SectionLink-B4qdwgZq.js`, 404),
            refused(`http://localhost/assets/Fine-a1b2c3d4.js`, 200),
            refused(`http://localhost/api/thing`, 500),
            refused(`https://elsewhere.dev/x-a1b2c3d4.js`, 404),
        ]);
    // The test DOM defines fetch as an accessor, which spyOn cannot wrap: the property is swapped and put back instead.
    const realFetch = Object.getOwnPropertyDescriptor(globalThis, `fetch`);
    const fetched = jest.fn((..._asked: unknown[]) => Promise.resolve(new Response(``)));
    Object.defineProperty(globalThis, `fetch`, { configurable: true, writable: true, value: fetched });
    try {
        expect(await outcome(loadChunk(dead))).toBe(`pending`);
        expect(fetched.mock.calls).toEqual([[`http://localhost/assets/SectionLink-B4qdwgZq.js`, { cache: `reload` }]]);
        expect(assign.mock.calls).toEqual([[`/files?path=a`]]);
    } finally {
        if (realFetch !== undefined) {
            Object.defineProperty(globalThis, `fetch`, realFetch);
        }
        entries.mockRestore();
    }
});

// The tab-wide ceiling (reloadReason.ts) has the last word over this path's own once-per-page rule.
it(`rejects a dead chunk without reloading once the tab has reloaded itself three times this minute`, async () => {
    const now = Date.now();
    sessionStorage.setItem(`intentic.automaticReloads`, [now - 3_000, now - 2_000, now - 1_000].join(`,`));
    await expect(loadChunk(dead)).rejects.toBe(deadChunk);
    expect(assign.mock.calls).toEqual([]);
});

it(`catches the preload Vite failed for an import nobody wrapped, and cancels it only when it reloads`, () => {
    const target = new EventTarget() as Window;
    installChunkRecovery(target);
    const first = new Event(`vite:preloadError`, { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    // This destination's one reload is spent: the error is left to throw, so the caller's own fallback shows.
    const second = new Event(`vite:preloadError`, { cancelable: true });
    target.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(assign.mock.calls).toEqual([[`/files?path=a`]]);
});

// The stack the editor reported from a popped-out chat left open across two re-bundles: the file viewer, first imported
// after the second one, rendered its slot with one Vue while the window ran on another.
const mixedStack = (first: string, second: string): TypeError => {
    const error = new TypeError(`Cannot read properties of null (reading 'ce')`);
    error.stack = [
        `TypeError: Cannot read properties of null (reading 'ce')`,
        `    at renderSlot (https://localhost:47145/node_modules/.vite/deps/vue.runtime.esm-bundler-OvXPuxnP.js?v=${first}:4016:31)`,
        `    at Proxy._sfc_render (https://localhost:47145/src/features/workspace/explorer/FileBreadcrumb.vue:63:4)`,
        `    at renderComponentRoot (https://localhost:47145/node_modules/.vite/deps/vue.runtime.esm-bundler-OvXPuxnP.js?v=${second}:4881:35)`,
    ].join(`\n`);
    return error;
};

it(`reads a stack running one dependency under two bundle generations as a stale page, however the error is worded`, () => {
    expect(isStaleChunkError(mixedStack(`4267b4fc`, `72918e0c`))).toBe(true);
});

it(`does not read the same error from one generation as stale: that is a bug in the code, and reloading it would loop`, () => {
    expect(isStaleChunkError(mixedStack(`72918e0c`, `72918e0c`))).toBe(false);
    // Two different dependencies on two hashes is not two copies of anything.
    const error = new TypeError(`boom`);
    error.stack = `TypeError: boom\n    at a (/node_modules/.vite/deps/vue.js?v=aaaa1111:1:1)\n    at b (/node_modules/.vite/deps/shiki.js?v=bbbb2222:1:1)`;
    expect(isStaleChunkError(error)).toBe(false);
});
