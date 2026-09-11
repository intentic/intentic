// @vitest-environment jsdom
// A machine reached by desktop sync alone is a real, live device that no capability card accounts for. This page used
// to show no trace of it while the Devices board listed it as live — one machine, two screens, two answers. These
// mount the Linux PC card with exactly that machine in the daemon's device list.
import type { Device } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { expect, it, vi } from "vitest";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";

const NOW = 1_700_000_000_000;

const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card: `linux` }, query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// No capabilities at all: the card exists, and nothing is connected on it. The machine below is the only row it can
// possibly draw, so anything on screen came from the device list.
vi.mock(`./connect/useCapabilities`, () => ({
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

// The Linux PC card is contributed by the devices extension, not the static catalog, so the card under test only
// exists while this is enabled.
const devicesExtension = {
    id: `intentic.devices`,
    manifest: {
        contributes: {
            capabilities: [
                {
                    id: `linux`,
                    kind: `host`,
                    catalog: { name: `Linux PC`, logo: `linux`, description: `Your Linux PC, shell, files, desktop.`, category: `devices` },
                    fields: [],
                },
            ],
        },
    },
};
vi.mock(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({
        contributionOf: () => undefined,
        enabled: ref([devicesExtension]),
        extensions: ref([devicesExtension]),
        settled: ref(true),
    }),
}));
vi.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
vi.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../sandbox/devices/useVpn`, () => ({
    importForticlient: vi.fn(),
    useVpn: () => ({ links: ref([]), error: ref(undefined), connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

// The daemon's device registry, the list both screens now read. Only `useDevices` is replaced; everything else in
// that module keeps working for whatever else the page mounts.
const fleet = ref<Device[]>([]);
vi.mock(import(`../sandbox/devices/useDevices`), async (importOriginal) => ({
    ...(await importOriginal()),
    useDevices: () => ({
        devices: computed(() => fleet.value),
        readAt: computed(() => NOW),
        error: computed(() => undefined),
        isLoading: ref(false),
        refetch: vi.fn(),
    }),
}));

const { default: Capabilities } = await import("./Capabilities.vue");

// One Linux machine, syncing and freshly reported, with no host capability behind it.
const syncOnly = (overrides: Partial<Device> = {}): Device => ({
    key: `radarsu-rog`,
    label: `radarsu-rog`,
    sync: { machine: `radarsu-rog`, mode: `sync`, seenAt: NOW },
    platform: `linux`,
    report: {
        hostname: `radarsu-rog`,
        os: `linux`,
        sandboxes: [],
        pairings: [],
        ports: [],
        agent: { running: true, installed: `1.252.0` },
        capturedAt: NOW,
    },
    ...overrides,
});

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
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

const connectionsGroup = (el: HTMLElement): HTMLElement | undefined =>
    [...el.querySelectorAll<HTMLElement>(`*`)].find(
        (node) => node.textContent?.includes(`Your connections`) === true && node.querySelector(`button`) !== null,
    );

it(`lists a machine that only syncs, on the card that would give it commands`, async () => {
    fleet.value = [syncOnly()];
    const el = mount();
    await nextTick();

    const group = connectionsGroup(el);
    expect(group?.textContent).toContain(`radarsu-rog`);
    // The same word the Devices board gives it: the two screens are reading one list now.
    expect(group?.textContent).toContain(`live`);
    // And what it still cannot do, which is the reason it is on this card rather than absent from it.
    expect(group?.textContent).toContain(`no command access`);
});

it(`carries the machine's own name into the form that connects it`, async () => {
    fleet.value = [syncOnly()];
    push.mockClear();
    const el = mount();
    await nextTick();

    const connect = [...(connectionsGroup(el)?.querySelectorAll(`button`) ?? [])].find((button) => button.textContent?.includes(`Connect`));
    connect?.click();
    await nextTick();

    // Named after the enrollment on purpose: both doors answering to one name is what folds them into a single row.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { card: `linux` }, query: expect.objectContaining({ device: `radarsu-rog` }) }));
});

it(`says nothing about a machine already connected as a device`, async () => {
    fleet.value = [syncOnly({ hostId: `radarsu-rog`, online: true })];
    const el = mount();
    await nextTick();

    // It is a capability instance now, and this card draws it the ordinary way — never twice. Asserted over the whole
    // card, since with no instance mocked in there is no connections group at all for it to hide in.
    expect(el.textContent).not.toContain(`no command access`);
    expect(connectionsGroup(el)).toBeUndefined();
});
