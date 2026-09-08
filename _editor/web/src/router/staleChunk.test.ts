// @vitest-environment jsdom
// jsdom: the router half of stale-chunk recovery — a failed dynamic import after redeploy gets the reload
// the user would do by hand. The asyncView half (same staleChunk module) is covered in asyncView.test.ts.
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { router } from "./index";

// vitest.setup.ts installs the browser globals before this file loads, so the static import above is safe.

// location is replaced globally; jsdom's real location is unforgeable, and the handler reads it at call time.
const assign = vi.fn();

beforeAll(() => {
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: { assign, href: `http://localhost/`, origin: `http://localhost`, pathname: `/` },
    });
    // Failing lazy routes phrased the way each runtime reports a dead chunk fetch.
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

it(`reloads onto the route whose chunk is gone: once, and lands there rather than where the user was`, async () => {
    await router.push(`/stale-chunk`).catch(() => undefined);
    expect(assign).toHaveBeenCalledWith(`/stale-chunk`);

    // Only a landing navigation clears the flag, so a genuinely broken deploy won't loop on retry.
    await router.push(`/stale-chunk`).catch(() => undefined);
    expect(assign).toHaveBeenCalledTimes(1);
});

it(`leaves a real load-time error alone: reloading a coding bug would loop, not recover`, async () => {
    await router.push(`/broken-component`).catch(() => undefined);
    expect(assign).not.toHaveBeenCalled();
});
