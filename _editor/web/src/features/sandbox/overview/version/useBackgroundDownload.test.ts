// The update card's ask for the next update's download, made once when it opens: only to the machine that runs this
// sandbox, only when that machine's agent says it runs the download unattended, at most once per release per half hour
// in a tab, and silently, like the machine's own timer.
import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { listedDevice } from "../../../../testing/listedDevice";
import { START_AGAIN_MS } from "./updateDownload";

const devices = ref<Device[]>([]);
const sent: { hostId: string; slug: string; op: string }[] = [];
let answer: () => Promise<string> = async () => `intentic: 1.54.0 is downloaded and built`;
jest.mock(`../../devices/useDevices`, () => ({
    useDevices: () => ({ devices }),
    manageDeviceSandbox: async (hostId: string, slug: string, op: string): Promise<string> => {
        sent.push({ hostId, slug, op });
        return await answer();
    },
}));
const invalidated: unknown[] = [];
jest.mock(`../../../../lib/queryPersistence`, () => ({
    queryClient: { invalidateQueries: async (filter: unknown) => void invalidated.push(filter) },
}));

const { useBackgroundDownload } = await import("./useBackgroundDownload");

// The machine that runs `demo`, connected and online, and what its agent says it can do.
const rog = (features: string[]): Device =>
    listedDevice({
        key: `rog`,
        label: `rog`,
        hostId: `host-rog`,
        online: true,
        sandboxes: [{ slug: `demo`, container: `intentic-sandbox-demo`, running: true, image: `ghcr.io/intentic/sandbox:stable` }],
        facts: { os: `linux`, arch: `x64`, shell: `bash`, home: `/home/ada`, roots: [`/home/ada`], features },
    });

const WANTED = { slug: `demo`, version: `1.54.0` };
const wanted = ref<typeof WANTED | undefined>(WANTED);
let app: App | undefined;
let starting: { value: boolean } | undefined;

const mount = (): void => {
    app = createApp(
        defineComponent({
            setup() {
                starting = useBackgroundDownload(() => wanted.value).starting;
                return () => h(`div`);
            },
        }),
    );
    app.mount(document.createElement(`div`));
};

const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    devices.value = [];
    wanted.value = WANTED;
    sent.length = 0;
    invalidated.length = 0;
    answer = async () => `intentic: 1.54.0 is downloaded and built`;
    sessionStorage.clear();
});

it(`asks the machine that runs this sandbox for the unattended download, once, and re-reads the card when it answers`, async () => {
    devices.value = [rog([`set-shape`, `background-prepare`])];
    mount();
    expect(starting?.value).toBe(true);
    await settle();
    expect(sent).toEqual([{ hostId: `host-rog`, slug: `demo`, op: `prepare-background` }]);
    expect(starting?.value).toBe(false);
    expect(invalidated).toHaveLength(1);
});

it(`never asks an agent that does not say it can, or a machine that is not the one running this sandbox`, async () => {
    devices.value = [rog([`set-shape`])];
    mount();
    await settle();
    devices.value = [{ ...rog([`background-prepare`]), sandboxes: [{ slug: `other`, container: `intentic-sandbox-other`, running: true, image: `ghcr.io/intentic/sandbox:stable` }] }];
    await settle();
    devices.value = [{ ...rog([`background-prepare`]), online: false }];
    await settle();
    expect(sent).toEqual([]);
});

it(`asks only while the card wants the download, and again for the same release only after half an hour`, async () => {
    wanted.value = undefined;
    devices.value = [rog([`background-prepare`])];
    mount();
    await settle();
    expect(sent).toEqual([]);
    wanted.value = WANTED;
    await settle();
    expect(sent).toHaveLength(1);
    // The same release, asked again by a reload of the card within the half hour: the machine is already on it.
    app?.unmount();
    mount();
    await settle();
    expect(sent).toHaveLength(1);
    sessionStorage.setItem(`intentic.update.download-asked.demo.1.54.0`, String(Date.now() - START_AGAIN_MS));
    app?.unmount();
    mount();
    await settle();
    expect(sent).toHaveLength(2);
    // A newer release is its own ask.
    wanted.value = { slug: `demo`, version: `1.55.0` };
    await settle();
    expect(sent.map((ask) => ask.op)).toEqual([`prepare-background`, `prepare-background`, `prepare-background`]);
});

it(`says nothing when the machine refuses or fails, and leaves the card to offer the update as it would have`, async () => {
    answer = async () => {
        throw new Error(`The agent on "host-rog" is too old to download an update in the background.`);
    };
    devices.value = [rog([`background-prepare`])];
    mount();
    await settle();
    expect(sent).toHaveLength(1);
    expect(starting?.value).toBe(false);
    expect(invalidated).toHaveLength(1);
});
