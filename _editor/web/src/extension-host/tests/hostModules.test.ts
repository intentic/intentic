// fair-condor-wskg, steady-lantern-82yp, clear-harbor-mtni (10-09 → 10-18): /ext/deployments drew no remembered look,
// then one only in source, then one only once its pin moved, because each bundle wired its own wait and each shipped copy
// was another chance to lose it. A bundle's own vue-query read, through the module the host hands it, joins the wait of
// the view it is read in, so a view drawn in a host <Await> keeps its remembered look until that read answers, however
// old the bundle is.
import "@intentic/testing/dom";
import { IMPRINT_VERSION, type SkeletonImprint } from "@intentic/ui/skeleton-imprint";
import { clearImprints, rememberImprint } from "@intentic/ui/skeleton-store";
import { Await, MINIMUM_HOLD_MS, REVEAL_DELAY_MS } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// What a bundle's `import { useQuery } from "@tanstack/vue-query"` resolves to: the module the host publishes.
await import("../hostModules");
// SAFETY: hostModules (imported above) has just published the host's modules on the global, vue-query among them.
// oxlint-disable-next-line no-underscore-dangle -- the host-bridge global the ext-shims re-export from
const hostQuery = globalThis.__intenticHost?.modules[`@tanstack/vue-query`] as typeof import("@tanstack/vue-query");

beforeAll(() => {
    const sheet = document.createElement(`style`);
    sheet.textContent = `.contents { display: contents } .hidden { display: none }`;
    document.head.append(sheet);
});

let app: App | undefined;
afterEach(async () => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
    await clearImprints();
});

const flush = async (): Promise<void> => {
    for (let beat = 0; beat < 4; beat += 1) {
        await nextTick();
    }
};
const advance = async (ms: number): Promise<void> => {
    jest.advanceTimersByTime(ms);
    await flush();
};

const NAME = `ext:deployments/board`;
const remembered: SkeletonImprint = {
    v: IMPRINT_VERSION,
    at: 0,
    t: [`ghost-row`],
    root: { e: `div`, k: [{ e: `p`, c: 0, k: [{ h: 10, w: [80] }] }] },
};

it(`holds an extension's view in its remembered look until the bundle's own read answers`, async () => {
    jest.useFakeTimers();
    rememberImprint(`default`, NAME, remembered);
    let answer: (rows: readonly string[]) => void = () => {};
    // A bundle that draws no wait of its own: it reads, and draws whatever it has.
    const Board = defineComponent({
        setup: () => {
            const query = hostQuery.useQuery({
                queryKey: [`deployments`],
                queryFn: () =>
                    new Promise<readonly string[]>((resolve) => {
                        answer = resolve;
                    }),
            });
            return () => h(`p`, { "data-board": `` }, (query.data.value ?? []).join(`,`));
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(Await, { of: { state: `ready`, data: Board, refreshing: false, refreshError: undefined }, imprint: NAME }, { default: () => h(Board) }),
    });
    app.component(`Icon`, IconStub);
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.mount(host);

    await advance(REVEAL_DELAY_MS);
    expect(host.querySelector(`[data-skeleton-snapshot]`)).not.toBeNull();
    expect(host.querySelector(`.hidden [data-board]`)).not.toBeNull();

    answer([`api`, `web`]);
    await flush();
    await advance(MINIMUM_HOLD_MS);
    expect(host.querySelector(`[data-skeleton-snapshot]`)).toBeNull();
    expect(host.querySelector(`.hidden`)).toBeNull();
    expect(host.querySelector(`[data-board]`)?.textContent).toBe(`api,web`);
});
