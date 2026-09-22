// A machine reached by desktop sync alone is a real, live device that no capability tile accounts for. This page used
// to show no trace of it while the Devices board listed it as live — one machine, two screens, two answers. These
// mount the Linux PC tile with exactly that machine in the daemon's device list.
import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { it, expect, mock } from "bun:test";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import * as actualVueRouter from "vue-router";
import * as actualUseDevices from "../sandbox/devices/useDevices";

const NOW = 1_700_000_000_000;

const push = mock();
mock.module(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ params: { entry: `linux` }, query: {} }) as never,
    useRouter: () => ({ push, replace: mock() }) as never,
}));

// No capabilities at all: the tile exists, and nothing is connected on it. The machine below is the only row it can
// possibly draw, so anything on screen came from the device list.
mock.module(`./connect/useCapabilities`, () => ({
    useCapabilities: () => ({
        recommendationFor: () => undefined,
        capabilities: ref([]),
        error: ref(undefined),
        add: mock(),
        remove: { mutateAsync: mock(), isPending: ref(false) },
        rename: { mutateAsync: mock(), isPending: ref(false) },
        refetch: mock(),
        dismissRecommendation: { mutateAsync: mock(), isPending: ref(false) },
    }),
    browseMarketplace: mock(),
    // The connect forms read these at link time though no case here opens one; a mock missing a name anything in
    // the graph imports is refused.
    readRemoteRefs: mock(async () => ({ refs: [] })),
    probeCapability: mock(),
}));

// The Linux PC tile is contributed by the devices extension, not the static catalog, so the tile under test only
// exists while this is enabled.
const devicesExtension = {
    id: `intentic.devices`,
    manifest: {
        contributes: {
            capabilities: [
                {
                    id: `linux`,
                    kind: `device`,
                    catalog: { name: `Linux PC`, logo: `linux`, description: `Your Linux PC, shell, files, desktop.`, category: `devices` },
                    fields: [],
                },
            ],
        },
    },
};
mock.module(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({
        contributionOf: () => undefined,
        enabled: ref([devicesExtension]),
        extensions: ref([devicesExtension]),
        settled: ref(true),
    }),
}));
mock.module(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
mock.module(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: mock(), stop: mock() }),
    viewProcessLogs: mock(),
}));
mock.module(`../sandbox/devices/useVpn`, () => ({
    importForticlient: mock(),
    useVpn: () => ({ links: ref([]), error: ref(undefined), connect: mock(), disconnect: mock() }),
}));
mock.module(`../sandbox/devices/useNetdisk`, () => ({
    useNetdisk: () => ({ links: ref([]), error: ref(undefined), mount: mock(), unmount: mock() }),
}));
mock.module(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
mock.module(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

// The daemon's device registry, the list both screens now read. Only `useDevices` and the revoke are replaced;
// everything else in that module keeps working for whatever else the page mounts.
const fleet = ref<Device[]>([]);
// Which machine the tile asked the daemon to cut off; no device connection needed, unlike everything else here.
const revoked: string[] = [];
mock.module(`../sandbox/devices/useDevices`, () => ({
    ...actualUseDevices,
    useDevices: () => ({
        devices: computed(() => fleet.value),
        readAt: computed(() => NOW),
        error: computed(() => undefined),
        isLoading: ref(false),
        refetch: mock(),
    }),
    revokeSyncDevice: async (machine: string) => void revoked.push(machine),
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
    // The confirmation dialog is a PrimeVue Dialog and reads the plugin's config while rendering.
    app.use(PrimeVue);
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

it(`lists a machine that only syncs, on the tile that would give it commands`, async () => {
    fleet.value = [syncOnly()];
    const el = mount();
    await nextTick();

    const group = connectionsGroup(el);
    expect(group?.textContent).toContain(`radarsu-rog`);
    // The same word the Devices board gives it: the two screens are reading one list now.
    expect(group?.textContent).toContain(`live`);
    // And what it still cannot do, which is the reason it is on this tile rather than absent from it.
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
    expect(push).toHaveBeenCalledWith(
        expect.objectContaining({ params: { entry: `linux` }, query: expect.objectContaining({ device: `radarsu-rog` }) }),
    );
});

// The row's other half. A machine listed under "your connections" holds no capability to remove, so without this the
// only way off this screen was the Devices board — which is where the reader is not.
it(`ends the machine's access from the tile that lists it, after naming what stops`, async () => {
    fleet.value = [syncOnly()];
    revoked.length = 0;
    const el = mount();
    await nextTick();

    const disconnect = [...(connectionsGroup(el)?.querySelectorAll(`button`) ?? [])].find((button) => button.textContent?.includes(`Disconnect`));
    disconnect?.click();
    await nextTick();

    // The confirm is the whole point of the second click: revoking stops file sync and port mirroring.
    expect(document.body.textContent).toContain(`Disconnect radarsu-rog?`);
    expect(revoked).toEqual([]);

    // Last, not first: the row's own button carries the same word, and the dialog's is the one that acts.
    const confirm = [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `Disconnect`);
    confirm?.click();
    await nextTick();

    expect(revoked).toEqual([`radarsu-rog`]);
});

it(`says nothing about a machine already connected as a device`, async () => {
    fleet.value = [syncOnly({ hostId: `radarsu-rog`, online: true })];
    const el = mount();
    await nextTick();

    // It is a capability instance now, and this tile draws it the ordinary way — never twice. Asserted over the whole
    // tile, since with no instance mocked in there is no connections group at all for it to hide in.
    expect(el.textContent).not.toContain(`no command access`);
    expect(connectionsGroup(el)).toBeUndefined();
});
