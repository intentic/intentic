// The FortiClient import is an affordance worth pinning: these tests mount the real tile and drop a file on it,
// since anything short of that (finding, opening, copying the config by hand) is slow enough to make re-typing a
// gateway the faster path.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { ForticlientConnection } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";

// Mounting reads matchMedia (useDevice) and window.env (environment.ts) at module scope; see startAgent.test.ts.

// URL-driven: the route names the vpn tile and nothing navigates. Empty `query` isn't padding, the rail and grid
// filter read off it, so a route without one is one vue-router never hands out.
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ params: { entry: `vpn` }, query: {} }) as never,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) as never,
}));

// Stubbed to an empty-but-settled sandbox (no capabilities, no extension tiles, no tunnels); the vpn tile comes
// from the static catalog regardless, so it, its form, and the import block are the whole subject.
jest.mock(`./connect/useCapabilities`, () => ({
    useCapabilities: () => ({
        recommendationFor: () => undefined,
        capabilities: ref([]),
        error: ref(undefined),
        add: jest.fn(),
        remove: { mutateAsync: jest.fn(), isPending: ref(false) },
        rename: { mutateAsync: jest.fn(), isPending: ref(false) },
        refetch: jest.fn(),
        dismissRecommendation: { mutateAsync: jest.fn(), isPending: ref(false) },
    }),
    browseMarketplace: jest.fn(),
    // The connect forms read these at link time though no case here opens one; a mock missing a name anything in
    // the graph imports is refused.
    readRemoteRefs: jest.fn(async () => ({ refs: [] })),
    probeCapability: jest.fn(),
}));
jest.mock(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({ contributionOf: () => undefined, enabled: ref([]), extensions: ref([]), settled: ref(true) }),
}));
// The Extension tile's signpost reads two counts from here; empty renders the sentence without them, a first-visit
// state.
jest.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
jest.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: jest.fn(), stop: jest.fn() }),
    viewProcessLogs: jest.fn(),
}));
jest.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: jest.fn(), refresh: jest.fn(), start: jest.fn(), stop: jest.fn() }),
}));
jest.mock(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

// The one daemon call the import makes; what the spy receives (XML, not a filename) proves the file was actually
// read here.
const importForticlient = jest.fn<(xml: string) => Promise<ForticlientConnection[]>>();
// The whole composable, not just its list: <LiveLinkRows> both opens and lists, reading `error` on every render.
jest.mock(`../sandbox/devices/useLiveLinks`, () => ({
    importForticlient: (xml: string) => importForticlient(xml),
    useLiveLinks: () => ({ links: ref([]), error: ref(undefined), open: jest.fn(), close: jest.fn() }),
}));

const { default: Capabilities } = await import("./Capabilities.vue");

const connection = (overrides: Partial<ForticlientConnection> = {}): ForticlientConnection => ({
    id: `safety-hab`,
    label: `safety-hab`,
    provider: `fortinet`,
    server: `91.234.246.82`,
    port: 10444,
    needs: [`username`, `password`],
    ...overrides,
});

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
    // Registered app-wide by the router plugin in the real app, which this mount deliberately skips.
    app.component(
        `RouterLink`,
        defineComponent({
            setup:
                (_, { slots }) =>
                () =>
                    h(`a`, slots["default"]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// The only droppable element in the import block; it names what it wants in words.
const dropZone = (el: HTMLElement): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Drop the configuration file here`))!;
// Everything the import section renders, not the vpn form (which has its own WireGuard textarea); anchored on the
// file input rather than the zone, since the zone relabels itself as it reads.
const importBlock = (el: HTMLElement): HTMLElement => el.querySelector<HTMLInputElement>(`input[type="file"]`)!.parentElement!;

// jsdom has no DragEvent and `dataTransfer` isn't assignable on a plain Event, so it's defined directly; `size` is
// likewise read-only on a real File and is what the refusal test relies on.
const dropFile = async (el: HTMLElement, file: File): Promise<void> => {
    const event = new Event(`drop`, { bubbles: true, cancelable: true });
    Object.defineProperty(event, `dataTransfer`, { value: { files: [file], types: [`Files`] } });
    dropZone(el).dispatchEvent(event);
    await nextTick();
};
const configFile = (xml: string, size?: number): File => {
    const file = new File([xml], `forticlient_config.conf`, { type: `text/xml` });
    if (size !== undefined) {
        Object.defineProperty(file, `size`, { value: size });
    }
    return file;
};

it(`reads a dropped configuration and lists its connections, with nothing to paste into`, async () => {
    importForticlient.mockResolvedValue([connection(), connection({ id: `warszawa`, label: `ZTM Warszawa`, port: 10443 })]);
    const el = mount();

    expect(dropZone(el)).toEqual(expect.any(Object));
    // The paste lane is gone, not just deprioritised: no textarea sits beside the zone as a quiet fallback.
    expect(importBlock(el).querySelector(`textarea`)).toBeNull();

    await dropFile(el, configFile(`<forticlient_configuration/>`));
    await waitFor(() => expect(importForticlient).toHaveBeenCalledWith(`<forticlient_configuration/>`));
    await nextTick();

    expect(importBlock(el).textContent).toContain(`safety-hab`);
    expect(importBlock(el).textContent).toContain(`ZTM Warszawa`);
    // Named back, so a list of unfamiliar connections is attributable to the file that produced it.
    expect(importBlock(el).textContent).toContain(`forticlient_config.conf`);
});

it(`says so when the file holds no connections, instead of leaving the zone looking untouched`, async () => {
    importForticlient.mockResolvedValue([]);
    const el = mount();

    await dropFile(el, configFile(`<forticlient_configuration/>`));
    await waitFor(() => expect(el.textContent).toContain(`No VPN connections found in forticlient_config.conf`));
});

it(`refuses a file far too big to be a configuration without reading it into the tab`, async () => {
    importForticlient.mockClear();
    const el = mount();

    await dropFile(el, configFile(`<forticlient_configuration/>`, 900_000_000));

    await waitFor(() => expect(el.textContent).toContain(`far too big to be a FortiClient configuration`));
    expect(importForticlient).not.toHaveBeenCalled();
});
