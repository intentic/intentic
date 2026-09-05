// @vitest-environment jsdom
//
// jsdom because the subject is WHAT THE CARD PUTS ON SCREEN, and what it no longer does is half of it.
//
// This card used to hold the whole of desktop sync in the singular: "Syncing from radarsu-rog", the folder on
// that machine, a warning when it went quiet, and a Disable that revoked EVERY paired device from the corner
// of a card people opened to READ their state. Desktop sync is a property of each DEVICE, so all of that is a
// row in the Devices list above (SandboxDevices.test.ts pins it there). What is left here is the one job
// that happens before there is a device to put anything on: minting a pairing.
import type { Device } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the daemon client) and a media
// query (the UI barrel's useDevice), exactly as SandboxDevices.test.ts cuts the same edge.

const canOperate = ref(true);
const pairToken = ref<string | undefined>(undefined);
const pairMode = ref<`sync` | `mirror` | undefined>(undefined);
const takeover = ref(false);
const enable = vi.fn(async () => {});
vi.mock(`../../composables/sandbox/useDesktopSync`, () => ({
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

/* WHETHER A DEVICE ALREADY HOLDS FILE SYNC, which the card now reads off the LIST rather than a status call of
 * its own. It is the one fact about other machines this card still needs, because file sync is single-holder and
 * enrolling a second machine for it is a takeover the reader has to be warned about by name. */
const devices = ref<Device[]>([]);
vi.mock(`../../composables/sandbox/useDevices`, () => ({
    useDevices: () => ({ devices, error: ref(undefined), isLoading: ref(false), refetch: () => {} }),
}));
vi.mock(`../../components/ScriptSourceSwitch.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: DesktopSyncCard } = await import("./DesktopSyncCard.vue");

const holder = (label: string): Device => ({ key: label, label, sync: { machine: label, mode: `sync`, seenAt: Date.now() } });

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DesktopSyncCard) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
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
    pairToken.value = undefined;
    pairMode.value = undefined;
    takeover.value = false;
    enable.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The card's one job, and the one-liner is the whole deliverable: a token nobody can paste is a token that did
// nothing. (The e2e journey drives the same two blocks through a real daemon.)
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

// The ports-only flow, which is a different enrollment rather than a variant of the same one: no folder to pick,
// and any number of machines may hold one at once.
it(`mints a ports-only pairing and stops asking for a folder`, async () => {
    const el = mount();
    expect(el.querySelector(`#desktop-sync-folder`)).not.toBeNull();
    await clickButton(`Mirror ports only`);
    expect(el.querySelector(`#desktop-sync-folder`)).toBeNull();
    await clickButton(`Mirror ports to a device`);
    expect(enable).toHaveBeenCalledWith(`mirror`);
});

// A member never sees the choice: the daemon would cap their pairing at mirror anyway, so offering file sync
// would be a button whose answer contradicts its label.
it(`offers a member the mirror flow alone`, () => {
    canOperate.value = false;
    mount();
    expect(shown()).toContain(`As a collaborator`);
    expect(shown()).not.toContain(`Enable desktop sync`);
});

/* TAKEOVER IS OFFERED ONLY WHEN A MACHINE ACTUALLY HOLDS FILE SYNC, and it names it — that machine's sync stops,
 * which is the whole reason it is an opt-in rather than something Enable does quietly. The holder is read off
 * the devices list, so this is also what pins that the card stopped keeping its own idea of who is syncing. */
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

// A mirror-only machine is not a file-sync holder, so it must not produce a takeover prompt: adding a second
// mirror contends with nothing.
it(`does not treat a ports-only device as the sync holder`, () => {
    devices.value = [{ key: `colleague`, label: `colleague-pc`, sync: { machine: `colleague`, mode: `mirror`, seenAt: Date.now() } }];
    mount();
    expect(shown()).not.toContain(`Sync from a different device instead`);
});

/* WHERE THE STATUS WENT. A reader arriving with the old card in mind is told, once, rather than left hunting for
 * a "Syncing from" line that is now a row above. Cheap to say and it is the one navigational fact this card
 * still owes anybody. */
it(`points at the list for devices that are already paired`, () => {
    mount();
    expect(shown()).toContain(`Anything already paired is a row in`);
    // And it holds none of the old singular claims itself.
    expect(shown()).not.toContain(`Syncing from`);
    expect(shown()).not.toContain(`Disable sync`);
});
