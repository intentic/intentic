import type { LoopbackCatch, LoopbackCatchEvent } from "@intentic/sandbox-contract/webext";
import { catchLoopback, isLanding, loopbackFeatures } from "./loopback-catch.js";

// The catch against a hand-written slice of Chrome: which origins the owner allowed, the tab listener the catch adds,
// and the tabs it closes. A tab update is driven by calling the listener the way Chrome would.

type Listener = (tabId: number, change: { url?: string; status?: string }, tab: { id?: number; url?: string }) => void;

const fakeChrome = (origins: string[]) => {
    const listeners = new Set<Listener>();
    const removed: number[] = [];
    const chrome = {
        permissions: { contains: async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => origins.includes(origin)) },
        tabs: {
            onUpdated: { addListener: (listener: Listener) => listeners.add(listener), removeListener: (listener: Listener) => listeners.delete(listener) },
            remove: async (tabId: number) => {
                removed.push(tabId);
            },
        },
    };
    Object.assign(globalThis, { chrome });
    return { listeners, removed, update: (tabId: number, url: string) => [...listeners].forEach((listener) => listener(tabId, { url }, { id: tabId, url })) };
};

const SPEC: LoopbackCatch = { id: "a", host: "localhost", port: 54_321, path: "/callback", expiresAt: Date.now() + 60_000, title: "Claude" };

const next = async (stream: AsyncGenerator<LoopbackCatchEvent>): Promise<LoopbackCatchEvent | undefined> => (await stream.next()).value ?? undefined;

test("a landing is the watched port and path on either loopback name, and nothing else", () => {
    expect(isLanding(SPEC, "http://localhost:54321/callback?code=x&state=y")).toBe(true);
    expect(isLanding(SPEC, "http://127.0.0.1:54321/callback?code=x")).toBe(true);
    expect(isLanding(SPEC, "https://localhost:54321/callback?code=x")).toBe(false);
    expect(isLanding(SPEC, "http://localhost:54322/callback?code=x")).toBe(false);
    expect(isLanding(SPEC, "http://localhost:54321/other?code=x")).toBe(false);
    expect(isLanding(SPEC, "http://evil.example:54321/callback?code=x")).toBe(false);
});

test("a browser not allowed on localhost neither offers the catch nor pretends to watch", async () => {
    fakeChrome([]);
    expect(await loopbackFeatures()).toEqual([]);
    const stream = catchLoopback(SPEC, undefined);
    expect(await next(stream)).toEqual({ type: "busy", reason: "this browser is not allowed on localhost, so it cannot see where the sign-in lands" });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
});

test("hands back the landing on the redirect's own host, closes the dead-end tab once, and stops when aborted", async () => {
    const chrome = fakeChrome(["http://localhost/*"]);
    expect(await loopbackFeatures()).toEqual(["loopback-catch"]);
    const abort = new AbortController();
    const stream = catchLoopback(SPEC, abort.signal);
    expect(await next(stream)).toEqual({ type: "listening" });
    chrome.update(7, "https://example.com/unrelated");
    chrome.update(9, "http://127.0.0.1:54321/callback?code=c&state=s");
    chrome.update(9, "http://127.0.0.1:54321/callback?code=c&state=s");
    expect(await next(stream)).toEqual({ type: "landed", url: "http://localhost:54321/callback?code=c&state=s" });
    expect(chrome.removed).toEqual([9]);
    abort.abort();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(chrome.listeners.size).toBe(0);
});
