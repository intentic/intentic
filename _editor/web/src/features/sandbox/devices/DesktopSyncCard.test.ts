// @vitest-environment jsdom
// jsdom because the subject is what the card puts on screen. The card used to hold all of desktop sync; that
// moved to a row per device in the Devices list (SandboxDevices.test.ts). What is left is minting a pairing.
import type { Device } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const canOperate = ref(true);
const pairToken = ref<string | undefined>(undefined);
const pairMode = ref<`sync` | `mirror` | undefined>(undefined);
const takeover = ref(false);
const enable = vi.fn(async () => {});
vi.mock(`./useDesktopSync`, () => ({
    useDesktopSync: () => ({
        canOperate,
        available: ref(true),
        folder: ref(`~/intentic/work`),
        defaultFolder: ref(`~/intentic/work`),
        pairToken,
        pairMode,
        minting: ref(false),
        takeover,
        linuxCommand: ref(`curl … | sh`),
        windowsCommand: ref(`iwr … | iex`),
        desktopLink: ref(undefined),
        enable,
        start: () => {},
        stop: () => {},
    }),
}));

// Whether a device already holds file sync, read off the devices list rather than a status call of its own:
// file sync is single-holder, so enrolling a second machine is a takeover the reader must be warned about by name.
const devices = ref<Device[]>([]);
// Enrolling a machine we can already reach: recorded rather than performed, since the subject is what the card
// sends — a device, a half, and a folder on THAT machine. The pairing and the command line are the daemon's.
const installCalls: { hostId: string; command: string; ask?: { mode?: string; localDir?: string } }[] = [];
vi.mock(`./useDevices`, () => ({
    useDevices: () => ({ devices, error: ref(undefined), isLoading: ref(false), refetch: () => {} }),
    runDeviceCommand: (hostId: string, command: string, ask?: { mode?: string; localDir?: string }) => {
        installCalls.push({ hostId, command, ask });
        return Promise.resolve({ ok: true, message: `That device is enrolled.` });
    },
}));
vi.mock(`../../capabilities/connect/ScriptSourceSwitch.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: DesktopSyncCard } = await import("./DesktopSyncCard.vue");

const holder = (label: string): Device => ({ key: label, label, sync: { machine: label, mode: `sync`, seenAt: Date.now() } });

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DesktopSyncCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

const shown = (): string => document.body.textContent ?? ``;
const clickButton = async (label: string): Promise<void> => {
    const button = [...document.body.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim().includes(label));
    button?.click();
    await nextTick();
};

afterEach(() => {
    canOperate.value = true;
    devices.value = [];
    installCalls.length = 0;
    pairToken.value = undefined;
    pairMode.value = undefined;
    takeover.value = false;
    enable.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The card's one job: a token nobody can paste is a token that did nothing.
it(`reveals the agent one-liner once a pairing is minted`, () => {
    pairToken.value = `pair_abc`;
    pairMode.value = `sync`;
    expect(shown()).not.toContain(`Linux / macOS`);
    mount();
    expect(shown()).toContain(`Run this on your device`);
    expect(shown()).toContain(`Linux / macOS`);
    expect(shown()).toContain(`Windows (PowerShell)`);
});

it(`mints a full sync pairing by default`, async () => {
    mount();
    await clickButton(`Enable desktop sync`);
    expect(enable).toHaveBeenCalledWith(`sync`);
});

// The ports-only flow is a different enrollment, not a variant: no folder to pick, and any number of machines
// may hold one at once.
it(`mints a ports-only pairing and stops asking for a folder`, async () => {
    const el = mount();
    expect(el.querySelector(`#desktop-sync-folder`)).not.toBeNull();
    await clickButton(`Mirror ports only`);
    expect(el.querySelector(`#desktop-sync-folder`)).toBeNull();
    await clickButton(`Mirror ports to a device`);
    expect(enable).toHaveBeenCalledWith(`mirror`);
});

// A member never sees the choice: the daemon caps their pairing at mirror anyway.
it(`offers a member the mirror flow alone`, () => {
    canOperate.value = false;
    mount();
    expect(shown()).toContain(`As a collaborator`);
    expect(shown()).not.toContain(`Enable desktop sync`);
});

// Takeover is offered only when a machine actually holds file sync, and names it, since taking over ends that
// device's sync.
it(`offers to take file sync over, naming the device that holds it`, async () => {
    devices.value = [holder(`radarsu-rog`)];
    mount();
    await clickButton(`Sync from a different device instead`);
    expect(shown()).toContain(`takes over from radarsu-rog`);
});

it(`does not offer a takeover when no device holds file sync`, () => {
    mount();
    expect(shown()).not.toContain(`Sync from a different device instead`);
});

// A mirror-only machine is not a file-sync holder, so it must not produce a takeover prompt.
it(`does not treat a ports-only device as the sync holder`, () => {
    devices.value = [{ key: `colleague`, label: `colleague-pc`, sync: { machine: `colleague`, mode: `mirror`, seenAt: Date.now() } }];
    mount();
    expect(shown()).not.toContain(`Sync from a different device instead`);
});

// A machine already connected as a device needs no one-liner: this sandbox can run the install out there itself.
it(`installs on a connected device instead of handing out its one-liner`, async () => {
    devices.value = [{ key: `ada-laptop`, label: `ada-laptop`, hostId: `ada-laptop`, online: true }];
    mount();
    expect(shown()).toContain(`Set up on ada-laptop`);
    await clickButton(`Set up on ada-laptop`);
    // The folder is the mocked card's own value, and it is a path on THAT machine, not in the sandbox.
    expect(installCalls).toEqual([{ hostId: `ada-laptop`, command: `sync-install`, ask: { mode: `sync`, localDir: `~/intentic/work` } }]);
});

// Ports-only is the other half of the same button: no folder crosses, because mirroring touches no files.
it(`enrolls a connected device for ports only without sending a folder`, async () => {
    devices.value = [{ key: `ada-laptop`, label: `ada-laptop`, hostId: `ada-laptop`, online: true }];
    mount();
    await clickButton(`Mirror ports only`);
    await clickButton(`Set up on ada-laptop`);
    expect(installCalls).toEqual([{ hostId: `ada-laptop`, command: `sync-install`, ask: { mode: `mirror` } }]);
});

// Each of these is a machine this sandbox cannot send a command to, or a flow the install command cannot carry.
it(`keeps to the one-liner for a device it cannot run on`, async () => {
    // Asleep, and enrolled-already, and a takeover (TAKEOVER=1 rides the one-liner alone).
    devices.value = [
        { key: `asleep`, label: `asleep-pc`, hostId: `asleep`, online: false },
        { key: `paired`, label: `paired-pc`, hostId: `paired`, online: true, sync: { machine: `paired`, mode: `mirror`, seenAt: Date.now() } },
    ];
    mount();
    expect(shown()).not.toContain(`Set up on asleep-pc`);
    expect(shown()).not.toContain(`Set up on paired-pc`);

    devices.value = [...devices.value, holder(`radarsu-rog`), { key: `ada`, label: `ada-laptop`, hostId: `ada`, online: true }];
    await nextTick();
    expect(shown()).toContain(`Set up on ada-laptop`);
    await clickButton(`Sync from a different device instead`);
    expect(shown()).not.toContain(`Set up on ada-laptop`);
    expect(installCalls).toEqual([]);
});

// Told once, where the old "Syncing from" line used to be, rather than left for the reader to hunt for.
it(`points at the list for devices that are already paired`, () => {
    mount();
    expect(shown()).toContain(`Anything already paired is a card on the`);
    // And it holds none of the old singular claims itself.
    expect(shown()).not.toContain(`Syncing from`);
    expect(shown()).not.toContain(`Disable sync`);
});
