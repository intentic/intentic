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

it(`a chunk that loads re-arms the reload for the next redeploy`, async () => {
    sessionStorage.setItem(`intentic.chunkReloaded`, `/files?path=a`);
    expect(await loadChunk(() => Promise.resolve(42))).toBe(42);
    expect(sessionStorage.getItem(`intentic.chunkReloaded`)).toBeNull();
    expect(await outcome(loadChunk(dead))).toBe(`pending`);
    expect(assign.mock.calls).toEqual([[`/files?path=a`]]);
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
