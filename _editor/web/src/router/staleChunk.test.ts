// @vitest-environment jsdom
// jsdom: the router half of stale-chunk recovery — a failed dynamic import after redeploy gets the reload
// the user would do by hand. The asyncView half (same staleChunk module) is covered in asyncView.test.ts.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { router } from "./index";
import { importOrReload } from "./staleChunk";

// vitest.setup.ts installs the browser globals before this file loads, so the static import above is safe.

// location is replaced globally; jsdom's real location is unforgeable, and the handler reads it at call time.
const assign = vi.fn();

beforeAll(() => {
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: { assign, href: `http://localhost/`, origin: `http://localhost`, pathname: `/chat`, search: `?agent=a1` },
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

// The imports with no navigation behind them: a terminal panel an agent surfaces mid-run, a model catalog reloaded
// after a turn failed. PostHog recorded these as bare unhandled rejections in live sessions — `useTerminalPanel`,
// `useWorkTerminals`, `useChat-catalog` — with the panel simply never opening, because a redeploy kills their chunk
// too and nothing was watching.
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

const reported = vi.spyOn(console, `error`).mockImplementation(() => undefined);

afterEach(() => {
    reported.mockClear();
});

it(`reloads onto the page the reader is on when a late import's chunk is gone: once`, async () => {
    const dead = (): Promise<{ open: () => void }> =>
        Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://x/assets/useTerminalPanel-a1b2.js`));
    importOrReload(dead, (module) => {
        module.open();
    });
    await settle();
    expect(assign).toHaveBeenCalledWith(`/chat?agent=a1`);
    expect(reported).not.toHaveBeenCalled();

    importOrReload(dead, (module) => {
        module.open();
    });
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
});

it(`reports any other import failure instead of dropping it, and reloads nothing`, async () => {
    importOrReload(
        () => Promise.reject(new TypeError(`NetworkError when attempting to fetch resource.`)),
        () => undefined,
    );
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(reported).toHaveBeenCalledOnce();
});

// A module that loaded is proof the chunks are current: whatever it then threw is this window's bug, and reloading on
// it would loop.
it(`reports what the loaded module throws rather than reading it as a redeploy`, async () => {
    importOrReload(
        () => Promise.resolve({}),
        () => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://x/assets/nested-c3d4.js`)),
    );
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(reported).toHaveBeenCalledOnce();
});
