// @vitest-environment jsdom
// THE TOGGLE THAT STARTS FILE SYNC, on the row that is read about. What is pinned here is the choice it puts in front
// of the reader: one folder per environment of the computer, each spelled in that environment's own filesystem, and a
// command that carries the folder — because the folder is what decides which side ends up running mutagen.
import type { Device } from "@intentic/sandbox-contract";
import { sandboxGroups } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { DeviceOps } from "../deviceOps";
import type { DeviceRow, MachineRow } from "../deviceRows";

vi.mock(`../../client/useSandbox`, () => ({
    useSandbox: () => ({ active: { value: { name: `work` } }, daemonUrl: { value: `https://sandbox-82789f4106b4.radarsu.com` } }),
}));

const { default: SandboxSyncToggles } = await import("./SandboxSyncToggles.vue");

const WINDOWS = { os: `Microsoft Windows 11 Home`, arch: `x64`, shell: `PowerShell 7`, home: `C:\\Users\\radar`, roots: [] };
const ARCH = { os: `Arch Linux`, arch: `x64`, shell: `/usr/bin/zsh`, home: `/home/radarsu`, roots: [], wsl: { distro: `archlinux` } };

const row = (device: Partial<Device> & { key: string }): DeviceRow =>
    ({ device: { label: device.key, ...device } as Device, groups: [], agent: undefined, chip: undefined }) as DeviceRow;

// Built by the kit's own grouping, so a group here is shaped exactly as the page's are.
const group = sandboxGroups([], [], [{ slug: `sandbox-82789f4106b4`, running: true, image: `dev` }])[0]!;

const sent: { command: string; folder: unknown; door: string | undefined }[] = [];
const ops = {
    working: { value: false },
    rowKey: () => `row`,
    syncRunning: () => false,
    runSync: async (environment: DeviceRow, _key: string, _sandboxId: string | undefined, command: string, folder?: unknown) => {
        sent.push({ command, folder, door: environment.device.hostId });
    },
} as unknown as DeviceOps;

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sent.length = 0;
});

const mount = (machine: MachineRow): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxSyncToggles, { machine, group, ops }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

// One PC, two environments: the Windows side holds the card, the distro is reached through it.
const pc = (): MachineRow =>
    ({
        key: `rog`,
        label: `rog`,
        environments: [row({ key: `rog`, hostId: `rog`, online: true, platform: `windows`, facts: WINDOWS }), row({ key: `rog-wsl`, facts: ARCH })],
        groups: [group],
    }) as unknown as MachineRow;

const fields = (el: HTMLElement): HTMLInputElement[] => [...el.querySelectorAll(`input`)];
const buttonSaying = (words: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(words));

it(`offers a folder per environment, each in that environment's own filesystem`, () => {
    const el = mount(pc());
    const paths = fields(el).map((field) => field.value);
    expect(paths).toHaveLength(2);
    // A drive path for the Windows side, a unix path for the distro — the reader picks a side by picking a path.
    expect(paths[0]).toBe(`C:\\Users\\radar\\intentic\\work-82789f4106b4`);
    expect(paths[1]).toBe(`/home/radarsu/intentic/work-82789f4106b4`);
});

// Two distros of one PC can run the same OS, and "Arch Linux" twice is two labels nobody can choose between.
it(`names an environment by its distro as well as its OS`, () => {
    const el = mount(pc());
    const labels = [...el.querySelectorAll(`label`)].map((label) => label.textContent?.trim());
    expect(labels[0]).toBe(`Microsoft Windows 11 Home`);
    expect(labels[1]).toContain(`archlinux`);
});

const syncButtons = (): HTMLButtonElement[] => [...document.querySelectorAll(`button`)].filter((button) => button.textContent?.includes(`Sync files here`));

// THE CASE THIS EXISTS FOR: the folder is in the distro, the only card is the Windows side. Nothing here picks a
// side — the line goes through the door that is open and the daemon crosses by the folder's own dialect.
it(`sends the distro's folder through the Windows door, which is the only one open`, async () => {
    mount(pc());
    syncButtons()[1]?.click();
    await nextTick();

    expect(sent).toEqual([{ command: `sync-install`, folder: { mode: `sync`, localDir: `/home/radarsu/intentic/work-82789f4106b4` }, door: `rog` }]);
});

// The suggestion is a suggestion: what the reader types is what syncs, which is the whole of "I decide the path".
it(`sends the path as edited rather than the one it suggested`, async () => {
    const el = mount(pc());
    const field = fields(el)[1]!;
    field.value = `/srv/code/work`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    syncButtons()[1]?.click();
    await nextTick();

    expect(sent[0]?.folder).toEqual({ mode: `sync`, localDir: `/srv/code/work` });
});

it(`asks for ports without files as its own act, carrying no folder`, async () => {
    mount(pc());
    buttonSaying(`Mirror ports only`)?.click();
    await nextTick();
    expect(sent).toEqual([{ command: `sync-install`, folder: { mode: `mirror` }, door: `rog` }]);
});

// Nothing to press on a machine whose card is gone or asleep: the add-a-device dialog owns that case.
it(`says nothing when the machine has no open door`, () => {
    const cardless = { key: `rog`, label: `rog`, environments: [row({ key: `rog-wsl`, facts: ARCH })], groups: [group] } as unknown as MachineRow;
    expect(mount(cardless).textContent?.trim()).toBe(``);
});
