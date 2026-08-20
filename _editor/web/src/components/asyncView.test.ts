// @vitest-environment jsdom
//
// The routing rule "navigation never waits", at its mechanism. A route registered through asyncView must
// complete its navigation while the chunk is still in flight, draw its outline only once the wait is long
// enough to deserve being seen (loadingReveal's thresholds), swap to the real view the moment the code lands —
// and own the failure path the router can no longer see: a dead chunk answers with the stale-window reload,
// anything else with a notice that carries the retry.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type App, type Component, createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView, type Router } from "vue-router";
import { asyncView } from "./asyncView";

// jsdom's window.location is unforgeable, so the reload the recovery performs is observed through a replaced
// global — same trick as the router's own staleChunk suite.
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

// A real router at a real wrapped route — the claim under test is about NAVIGATION, not just rendering.
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

// The loader's promise settles through a few microtask hops (start's reset, attempt's catch, the finally) and
// Vue's flush rides the same queue — a handful of beats drains all of it without touching the fake timers.
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
    // The click landed — URL flipped — while the loader is still pending…
    expect(router.currentRoute.value.path).toBe(`/target`);
    // …and a wait shorter than the reveal delay paints NO placeholder: a warm chunk must not flash grey.
    expect(el.querySelector(`[data-outline]`)).toBeNull();

    await vi.advanceTimersByTimeAsync(250);
    expect(el.querySelector(`[data-outline]`)).not.toBeNull();

    land({ default: defineComponent({ render: () => h(`div`, { "data-view": `` }) }) });
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(el.querySelector(`[data-outline]`)).toBeNull();
});

it(`a revisit renders synchronously — the chunk is fetched once and kept`, async () => {
    const load = vi.fn(() => Promise.resolve({ default: defineComponent({ render: () => h(`div`, { "data-view": `` }) }) }));
    const view = asyncView(load);
    const { router, el } = await mountAt(view);

    await router.push(`/target`);
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();

    await router.push(`/`);
    await router.push(`/target`);
    // One render flush and no loader beat: the remount paints the kept component in its first frame, and the
    // count is the proof nothing was fetched twice.
    await nextTick();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
});

it(`answers a dead chunk with one reload landed on the destination — and a notice once that reload is spent`, async () => {
    const dead = (): Promise<never> => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://x/assets/View-a1b2.js`));
    const first = await mountAt(asyncView(dead));
    await first.router.push(`/target`);
    await settle();
    expect(assign).toHaveBeenCalledWith(`/target`);
    // The page is being replaced — no failure surface flashed at it.
    expect(first.el.textContent).not.toContain(`couldn't load`);

    // The reloaded window (fresh wrapper, same sessionStorage) fails again: the chunk is GENUINELY gone.
    // One reload per destination — this time the failure is said, with the retry.
    const second = await mountAt(asyncView(dead));
    await second.router.push(`/target`);
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(second.el.textContent).toContain(`This view couldn't load.`);
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
    expect(el.textContent).toContain(`This view couldn't load.`);
    expect(el.textContent).toContain(`boom`);

    broken = false;
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Try again`))!.click();
    await settle();
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
});

it(`a chunk resolving re-arms the stale-window reload for the next redeploy`, async () => {
    // The guard was spent on some destination; landing any chunk is the proof this window's assets exist.
    sessionStorage.setItem(`intentic.chunkReloaded`, `/target`);
    const { router } = await mountAt(asyncView(() => Promise.resolve({ default: defineComponent({ render: () => h(`div`) }) })));
    await router.push(`/target`);
    await settle();
    expect(sessionStorage.getItem(`intentic.chunkReloaded`)).toBeNull();
});
