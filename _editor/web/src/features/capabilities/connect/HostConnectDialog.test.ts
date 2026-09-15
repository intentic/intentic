// @vitest-environment jsdom
// The command here is read and pasted onto a second machine, so a local dev build must not render it by repo path
// (the checkout isn't on that machine). Pins that flipping the script-source switch actually rewrites the copied
// line.
import type { Device } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// The composable reads only the sandbox's address and a minted pairing token; everything else in the command is
// built here.
vi.mock(`../../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ daemonUrl: ref(`https://sandbox-abc.intentic.dev`) }) }));
vi.mock(`../../sandbox/client/sandboxClient`, () => ({
    sandboxRequest: vi.fn(async () => ({ ok: true, json: async () => ({ token: `pair-token`, hosts: [] }) })),
}));
// The fleet the dialog reads Windows PCs' distros off; empty unless a test connects one.
const fleet = ref<Device[]>([]);
vi.mock(`../../sandbox/devices/useDevices`, () => ({
    useDevices: () => ({ devices: computed(() => fleet.value), readAt: ref(0), error: ref(undefined), isLoading: ref(false), refetch: () => {} }),
}));

const { default: HostConnectDialog } = await import("./HostConnectDialog.vue");
const { scriptSource } = await import("../../../app/environments/scriptCommand");

// Dialog content isn't under the mount point (PrimeVue teleports to body). `visible` starts false and flips, since
// minting hangs off that transition, as on the card.
const mount = (id = `my-desktop`): { open: () => void } => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const visible = ref(false);
    const app = createApp({
        render: () => h(HostConnectDialog, { visible: visible.value, id, platform: `linux`, permissions: `run commands` }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // PrimeVue's config is required for the header to render; the bare plugin, not installUi, since theme/icons aren't
    // on trial here.
    app.use(PrimeVue);
    app.mount(el);
    return {
        open: () => {
            visible.value = true;
        },
    };
};

const pill = (label: string): HTMLButtonElement =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)!;

it(`rewrites the command between the working-tree script and the released one`, async () => {
    document.body.innerHTML = ``;
    scriptSource.value = `checkout`;
    mount().open();

    // The token is minted on open, so the command only exists after that round trip.
    await vi.waitFor(() => expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`));
    expect(document.body.textContent).toContain(`sh _site/site/public/scripts/device.sh`);

    pill(`Standard`).click();

    // Same env, fetched delivery: the form for a machine that's never seen the repo. Waited for, not ticked, since
    // Shiki highlights in a promise and Code.vue holds the previous markup mid-flight, so the new command lands a
    // microtask later than the click.
    await vi.waitFor(() => expect(document.body.textContent).toContain(`curl -fsSL https://intentic.dev/device |`));
    expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`);
    expect(document.body.textContent).not.toContain(`_site/site/public/scripts/device.sh`);
});

// A distro of a Windows PC already connected is connected from that PC, where the reader has PowerShell open and
// not the distro's terminal: the same one-liner, handed to the distro through wsl.exe as one argument.
it(`hands a WSL distro's command to PowerShell when the device is named for one`, async () => {
    document.body.innerHTML = ``;
    scriptSource.value = `published`;
    fleet.value = [
        {
            key: `rog`,
            label: `rog`,
            hostId: `rog`,
            online: true,
            facts: { os: `Windows`, arch: `x64`, shell: `PowerShell 7`, home: `C:\\Users\\radar`, roots: [], hostname: `rog`, wslDistros: [`Arch`, `Ubuntu`] },
        },
    ];
    mount(`rog-wsl-arch`).open();

    await vi.waitFor(() => expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`));
    expect(document.body.textContent).toContain(`wsl -d Arch --exec sh -c "curl -fsSL https://intentic.dev/device |`);
    expect(document.body.textContent).toContain(`in PowerShell`);

    // The other way in stays one click away, for a reader already inside the distro.
    pill(`A terminal in the distro`).click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(`wsl -d Arch`));
    expect(document.body.textContent).toContain(`in a terminal`);
    fleet.value = [];
});
