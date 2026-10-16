// Setting a new sandbox up on a computer of the owner's that is already connected: one press per such machine, which
// runs the same `ic sandbox connect` the command would, with this row's code, through the sandbox that reaches it.
import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract";
import { installI18n } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { listedDevice } from "../../../testing/listedDevice";

const omen = listedDevice({ key: `omen`, label: `omen`, hostId: `omen`, online: true, sandboxes: [] });
const relays = ref<{ sandboxId: string; devices: Device[] }[]>([]);
const look = jest.fn(async () => {});
jest.mock(`../../sandbox/live/useDeviceRelays`, () => ({ useDeviceRelays: () => ({ relays: computed(() => relays.value), looking: ref(false), look }) }));
const manageDeviceSandbox = jest.fn(async () => `Set up.`);
jest.mock(`../../sandbox/devices/useDevices`, () => ({ manageDeviceSandbox }));

const { default: SetupOnMachine } = await import("../SetupOnMachine.vue");

let app: App | undefined;
const mount = async (syncAsked = false): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () => h(SetupOnMachine, { sandboxId: `row-1`, code: `ABCD-1234`, hostname: `sandbox-7e8d0ffa8bed.radarsu.com`, syncAsked }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    installI18n(app);
    app.mount(el);
    await nextTick();
    return el;
};

afterEach(() => {
    look.mockClear();
    app?.unmount();
    app = undefined;
    relays.value = [];
    manageDeviceSandbox.mockClear();
    document.body.innerHTML = ``;
});

it(`draws nothing while no sandbox of the owner's reaches a machine that could hold it`, async () => {
    const el = await mount();
    expect(el.querySelector(`[data-setup-on-machine]`)).toBeNull();
    // Asked fresh as the page opens, rather than trusting lists read before a machine was connected.
    expect(look).toHaveBeenCalledTimes(1);
});

it(`sets it up on the machine pressed, through the sandbox that reaches it, with this row's code`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    const el = await mount();
    const buttons = [...el.querySelectorAll(`button`)];
    expect(buttons.map((each) => each.textContent?.trim())).toEqual([`Set it up on omen`]);
    buttons[0]?.click();
    await nextTick();
    expect(manageDeviceSandbox).toHaveBeenCalledWith(`omen`, `sandbox-7e8d0ffa8bed`, `create`, expect.objectContaining({ setupCode: `ABCD-1234`, at: `intentic` }));
});

// The press does not carry the sync folder the command would: said, rather than dropped without a word.
it(`says file sync is left for afterwards when it was asked for`, async () => {
    relays.value = [{ sandboxId: `intentic`, devices: [omen] }];
    expect((await mount(true)).textContent).toContain(`File syncing isn't set up this way`);
});
