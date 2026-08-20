// @vitest-environment jsdom
//
// The FortiClient import is an AFFORDANCE, and the thing worth pinning is which one it offers. It used to be a
// four-row textarea: the file FortiClient writes had to be found, opened in something, selected and copied out
// before this page could do anything with it — enough steps that re-typing a gateway by hand was the faster
// path, which is the same as the import not existing. So these mount the real card and DROP A FILE on it.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { ForticlientConnection } from "@intentic/sandbox-contract";

// The import-time globals a mounted view needs (see startAgent.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.

// The page is URL-driven; the vpn card is what this file is about, so the route names it and nothing navigates.
// The empty `query` is not padding — the rail's slice and the grid's filter are read off it, so a route without
// one is a route vue-router never hands out. Partial, because the real router module is pulled in transitively
// and still has to build itself.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card: `vpn` }, query: {} }) as never,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) as never,
}));

// Everything the page reads from the daemon, stubbed to an empty-but-settled sandbox: no capabilities added, no
// extensions contributing cards, no tunnels up. The vpn card itself comes from the static catalog, so it is
// present regardless — the card, its form and the import block are the whole subject.
vi.mock(`../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({
        hasCapability: () => true,
        recommendationFor: () => undefined,
        capabilities: ref([]),
        error: ref(undefined),
        add: vi.fn(),
        remove: { mutateAsync: vi.fn(), isPending: ref(false) },
        rename: { mutateAsync: vi.fn(), isPending: ref(false) },
        refetch: vi.fn(),
        dismissRecommendation: { mutateAsync: vi.fn(), isPending: ref(false) },
    }),
    browseMarketplace: vi.fn(),
}));
vi.mock(`../composables/extensions/useExtensions`, () => ({
    useExtensions: () => ({ contributionOf: () => undefined, enabled: ref([]), extensions: ref([]), settled: ref(true) }),
}));
// The Extension card's signpost reads the registry cache for its two counts. Empty here: the sentence renders
// without them, which is exactly the state a first visit is in.
vi.mock(`../composables/extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
vi.mock(`../composables/terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
vi.mock(`../components/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../components/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

// The one daemon call the import makes. It takes XML and returns connections, so what the spy RECEIVES is the
// proof the file was read here rather than handed over as a name the daemon could never open.
const importForticlient = vi.fn<(xml: string) => Promise<ForticlientConnection[]>>();
vi.mock(`../composables/sandbox/useVpn`, () => ({
    importForticlient: (xml: string) => importForticlient(xml),
    useVpn: () => ({ links: ref([]) }),
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
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    // Registered app-wide by the router plugin in the real app, which this mount deliberately does without.
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

// The zone is the only thing in the import block that can be dropped on, and it says what it wants in words.
const dropZone = (el: HTMLElement): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Drop the configuration file here`))!;
// Everything the import section renders, and nothing the vpn FORM does — that form has a textarea of its own
// (the WireGuard config field), so "no textarea" is only a true statement about this block. Anchored on the
// file field rather than the zone: the zone relabels itself as it reads, and this has to resolve either way.
const importBlock = (el: HTMLElement): HTMLElement => el.querySelector<HTMLInputElement>(`input[type="file"]`)!.parentElement!;

// jsdom has no DragEvent, and `dataTransfer` is not assignable on a plain Event — define it, which is all the
// handler reads. `size`, likewise, is read-only on a real File and is what the refusal below turns on.
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

    expect(dropZone(el)).toBeDefined();
    // The paste lane is GONE, not merely deprioritised — a textarea left beside the zone is the step this
    // change exists to remove, quietly still on offer.
    expect(importBlock(el).querySelector(`textarea`)).toBeNull();

    await dropFile(el, configFile(`<forticlient_configuration/>`));
    await vi.waitFor(() => expect(importForticlient).toHaveBeenCalledWith(`<forticlient_configuration/>`));
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
    await vi.waitFor(() => expect(el.textContent).toContain(`No VPN connections found in forticlient_config.conf`));
});

it(`refuses a file far too big to be a configuration without reading it into the tab`, async () => {
    importForticlient.mockClear();
    const el = mount();

    await dropFile(el, configFile(`<forticlient_configuration/>`, 900_000_000));

    await vi.waitFor(() => expect(el.textContent).toContain(`far too big to be a FortiClient configuration`));
    expect(importForticlient).not.toHaveBeenCalled();
});
