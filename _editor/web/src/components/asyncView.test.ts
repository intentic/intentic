// @vitest-environment jsdom
// Navigation completes while the chunk is still in flight; the outline only shows past the reveal delay, then
// swaps to the real view. Owns the failure path: a dead chunk gets the stale-window reload, anything else a notice with
// retry.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type App, type Component, createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView, type Router } from "vue-router";
import { asyncView } from "./asyncView";

// window.location is unforgeable in jsdom; the reload is observed via a replaced global, per staleChunk.test.
const assign = vi.fn();
beforeAll(() => {
    Object.defineProperty(globalThis, `location`, {
        configurable: true,
        value: { assign, href: `http://localhost/`, origin: `http://localhost`, pathname: `/` },
    });
});

const mounted: { app: App; el: HTMLElement }[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    assign.mockClear();
});
afterEach(() => {
    for (const { app, el } of mounted.splice(0)) {
        app.unmount();
        el.remove();
    }
    vi.useRealTimers();
});

// Real router, real route: the claim under test is navigation, not just rendering.
const mountAt = async (view: Component): Promise<{ router: Router; el: HTMLElement }> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/`, component: { render: () => h(`div`, `home`) } },
            { path: `/target`, component: view },
        ],
    });
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(RouterView) });
    app.use(router);
    await router.push(`/`);
    app.mount(el);
    mounted.push({ app, el });
    return { router, el };
};

// Drains the loader's promise chain and Vue's render flush, which ride the same microtask queue, without
// touching fake timers.
const settle = async (): Promise<void> => {
    for (let beat = 0; beat < 8; beat += 1) {
        await nextTick();
    }
};

it(`completes the navigation before the chunk arrives, reveals the outline only past the delay, and swaps on landing`, async () => {
    let land!: (module: { default: Component }) => void;
    const view = asyncView(() => new Promise((resolve) => (land = resolve)), defineComponent({ render: () => h(`div`, { "data-outline": `` }) }));
    const { router, el } = await mountAt(view);

    await router.push(`/target`);
    // URL already flipped; the loader is still pending.
    expect(router.currentRoute.value.path).toBe(`/target`);
    // A wait under the reveal delay paints no placeholder; a warm chunk must not flash grey.
    expect(el.querySelector(`[data-outline]`)).toBeNull();

    await vi.advanceTimersByTimeAsync(250);
    expect(el.querySelector(`[data-outline]`)).not.toBeNull();

    land({ default: defineComponent({ render: () => h(`div`, { "data-view": `` }) }) });
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(el.querySelector(`[data-outline]`)).toBeNull();
});

it(`a revisit renders synchronously: the chunk is fetched once and kept`, async () => {
    const load = vi.fn(() => Promise.resolve({ default: defineComponent({ render: () => h(`div`, { "data-view": `` }) }) }));
    const view = asyncView(load);
    const { router, el } = await mountAt(view);

    await router.push(`/target`);
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();

    await router.push(`/`);
    await router.push(`/target`);
    // One flush, no loader beat: remount paints the kept component immediately; call count proves no refetch.
    await nextTick();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
});

it(`answers a dead chunk with one reload landed on the destination, and a notice once that reload is spent`, async () => {
    const dead = (): Promise<never> => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://x/assets/View-a1b2.js`));
    const first = await mountAt(asyncView(dead));
    await first.router.push(`/target`);
    await settle();
    expect(assign).toHaveBeenCalledWith(`/target`);
    // The page is being replaced; no failure surface flashes.
    expect(first.el.textContent).not.toContain(`couldn't load`);

    // Same sessionStorage, fresh wrapper, fails again: the chunk is genuinely gone, so this shows the retry.
    const second = await mountAt(asyncView(dead));
    await second.router.push(`/target`);
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(second.el.querySelector(`button`)).not.toBeNull();
    expect(second.el.textContent).not.toContain(`data-view`);
});

it(`says a non-chunk failure instead of reloading, and the retry re-fetches`, async () => {
    let broken = true;
    const load = vi.fn(() =>
        broken ? Promise.reject(new Error(`boom`)) : Promise.resolve({ default: defineComponent({ render: () => h(`div`, { "data-view": `` }) }) }),
    );
    const { router, el } = await mountAt(asyncView(load));
    await router.push(`/target`);
    await settle();

    expect(assign).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`boom`);
    const retry = el.querySelector(`button`) as HTMLButtonElement;
    expect(retry).not.toBeNull();

    broken = false;
    retry.click();
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
});

it(`a chunk resolving re-arms the stale-window reload for the next redeploy`, async () => {
    // The reload guard was already spent; landing any chunk proves this window's assets are current.
    sessionStorage.setItem(`intentic.chunkReloaded`, `/target`);
    const { router } = await mountAt(asyncView(() => Promise.resolve({ default: defineComponent({ render: () => h(`div`) }) })));
    await router.push(`/target`);
    await settle();
    expect(sessionStorage.getItem(`intentic.chunkReloaded`)).toBeNull();
});
