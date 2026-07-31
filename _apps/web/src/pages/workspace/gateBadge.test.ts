// @vitest-environment jsdom
//
// The badge MOUNTS, and its poll speeds up while something is in flight. Both halves guard the same seam: the
// interval callback runs synchronously inside useQuery, so a version of useGate that read the `query` it was
// destructuring threw "Cannot access 'query' before initialization" during setup — and because the badge sits
// inside the Changes panel, a throw there took the whole panel down. A unit test of the composable's return
// value cannot see this; only a mount can.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { GateVerdict } from "@intentic/sandbox-contract";

// The import-time globals a mount needs here: ui's useDevice reads window.matchMedia, and the chat chain
// GateBadge pulls in (the fix transcript's opener) reaches environment.ts's window.env.
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

// The daemon seam. Every fetch is counted, because the count over time IS the poll interval.
const verdict = ref<GateVerdict>({ status: `idle`, command: `pnpm test`, output: ``, fingerprint: ``, stale: false, implicated: [] });
let fetches = 0;
vi.mock(`../../composables/sandbox/sandboxClient`, () => ({
    sandboxJson: () => {
        fetches += 1;
        return Promise.resolve(verdict.value);
    },
}));
// The fix transcript's opener. Stubbed because the real fleet state pulls the chat/endpoint/auth chain, which
// has nothing to do with what this file pins.
vi.mock(`../../composables/agents/useAgents`, () => ({
    useAgents: () => ({ agentById: () => undefined, loadArchived: () => Promise.resolve(), open: () => undefined }),
}));
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ reachable: ref(true) }),
    sandboxKey: (...parts: unknown[]) => [...parts, `sandbox-1`],
}));

const queryClient = new QueryClient();
let GateBadge: unknown;
let app: App | undefined;

beforeAll(async () => {
    GateBadge = (await import(`./GateBadge.vue`)).default;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    vi.useRealTimers();
    fetches = 0;
});

const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(GateBadge as never) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

it(`mounts and states the verdict`, async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Checks haven't run`);
    expect(el.textContent).toContain(`Run checks`);
});

it(`polls fast while the checks are running and slowly once they settle`, async () => {
    vi.useFakeTimers();
    verdict.value = { ...verdict.value, status: `running` };
    await mount();
    const afterMount = fetches;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetches).toBeGreaterThan(afterMount);

    verdict.value = { ...verdict.value, status: `passed` };
    await vi.advanceTimersByTimeAsync(3_000);
    const settled = fetches;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetches).toBe(settled);
});
