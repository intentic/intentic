// @vitest-environment jsdom
//
// The stale-window recovery's ROUTER half: after a redeploy, a lazy route still loaded at route level (login,
// the auth handoffs, the shell record itself) points at a content-hashed chunk that no longer exists. The
// dynamic import rejects, vue-router aborts the navigation, and without a handler the URL just flickered back —
// a click that did nothing until a hard refresh. The handler answers a failed chunk load with the reload the
// user would perform by hand, landed on the route they asked for; these tests drive the real router at real
// failing routes. The in-shell views load through asyncView now, whose failures no router hook sees — that
// half of the recovery (same shared staleChunk module) is covered in components/asyncView.test.ts.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { router } from "./index";

// vi.hoisted runs above the imports, so the router module below evaluates with these already in place — which
// is why the import can be static. It used to be an `await import` inside beforeAll, and pulling the router's
// whole module graph there spent ~1s of a 10s hook budget on module loading rather than on the hook's work.
// On a loaded runner that is the difference between a pass and "Hook timed out in 10000ms".
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

// jsdom's window.location is unforgeable, so the navigation the handler performs is observed through a
// replaced global rather than a spy on the real object. The router only reads location at createWebHistory
// time; the handler's `location.assign` resolves through the global scope at call time.
const assign = vi.fn();

beforeAll(() => {
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: { assign, href: `http://localhost/`, origin: `http://localhost`, pathname: `/` },
    });
    // Real failing lazy routes, phrased the way each runtime phrases a dead chunk fetch.
    router.addRoute({
        path: `/stale-chunk`,
        component: () => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://x/assets/Detail-a1b2.js`)),
    });
    router.addRoute({
        path: `/broken-component`,
        component: () => Promise.reject(new TypeError(`Cannot read properties of undefined (reading 'foo')`)),
    });
});

beforeEach(() => {
    sessionStorage.clear();
    assign.mockClear();
});

it(`reloads onto the route whose chunk is gone — once, and lands there rather than where the user was`, async () => {
    await router.push(`/stale-chunk`).catch(() => undefined);
    expect(assign).toHaveBeenCalledWith(`/stale-chunk`);

    // The chunk is GENUINELY gone (a broken deploy): after the reload the fresh window's own navigation to
    // this target fails again, and that second failure must not loop. Only a navigation that LANDS clears the
    // flag — the next redeploy earns its one reload again — so the repeat here stays suppressed.
    await router.push(`/stale-chunk`).catch(() => undefined);
    expect(assign).toHaveBeenCalledTimes(1);
});

it(`leaves a real load-time error alone — reloading a coding bug would loop, not recover`, async () => {
    await router.push(`/broken-component`).catch(() => undefined);
    expect(assign).not.toHaveBeenCalled();
});
