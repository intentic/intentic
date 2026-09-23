// The command here is read and pasted onto a second machine, so a local dev build must not render it by repo path
// (the checkout isn't on that machine). Pins that flipping the script-source switch actually rewrites the copied
// line.
import "@intentic/testing/dom";
import type { Device } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { waitFor } from "@intentic/testing/bun";
import { computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// The composable reads only the sandbox's address and a minted pairing token; everything else in the command is
// built here.
jest.mock(`../../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ daemonUrl: ref(`https://sandbox-abc.intentic.dev`) }) }));
// The roster a test connects a machine into; the pair route answers a token regardless.
const roster = ref<unknown[]>([]);
jest.mock(`../../sandbox/client/sandboxClient`, () => ({
    sandboxRequest: jest.fn(async () => ({ ok: true, json: async () => ({ token: `pair-token`, hosts: roster.value }) })),
}));
// Taking the hostname is a rename, which is the capabilities composable's; this spies on the call rather than on the wire.
const renamed = jest.fn(async (_: { id: string; to: string }) => ({}));
jest.mock(`./useCapabilities`, () => ({ useCapabilities: () => ({ rename: { mutateAsync: renamed } }) }));
// The fleet the dialog reads Windows PCs' distros off; empty unless a test connects one.
const fleet = ref<Device[]>([]);
jest.mock(`../../sandbox/devices/useDevices`, () => ({
    useDevices: () => ({ devices: computed(() => fleet.value), readAt: ref(0), error: ref(undefined), isLoading: ref(false), refetch: () => {} }),
}));

const { default: HostConnectDialog } = await import("./HostConnectDialog.vue");
const { scriptSource } = await import("../../../app/environments/scriptCommand");

// Dialog content isn't under the mount point (PrimeVue teleports to body). `visible` starts false and flips, since
// minting hangs off that transition, as on the tile.
const mount = (id = `my-desktop`, unnamed = false): { open: () => void } => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const visible = ref(false);
    const app = createApp({
        render: () => h(HostConnectDialog, { visible: visible.value, id, platform: `linux`, permissions: `run commands`, unnamed, onRenamed }),
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

const onRenamed = jest.fn();

const pill = (label: string): HTMLButtonElement =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)!;

it(`rewrites the command between the working-tree script and the released one`, async () => {
    document.body.innerHTML = ``;
    scriptSource.value = `checkout`;
    mount().open();

    // The token is minted on open, so the command only exists after that round trip.
    await waitFor(() => expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`));
    expect(document.body.textContent).toContain(`sh _site/site/public/scripts/device.sh`);

    pill(`Standard`).click();

    // Same env, fetched delivery: the form for a machine that's never seen the repo. Waited for, not ticked, since
    // Shiki highlights in a promise and Code.vue holds the previous markup mid-flight, so the new command lands a
    // microtask later than the click.
    await waitFor(() => expect(document.body.textContent).toContain(`curl -fsSL https://intentic.dev/device |`));
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
            facts: {
                os: `Windows`,
                arch: `x64`,
                shell: `PowerShell 7`,
                home: `C:\\Users\\radar`,
                roots: [],
                hostname: `rog`,
                wslDistros: [`Arch`, `Ubuntu`, `docker-desktop`],
            },
        },
    ];
    mount(`rog-wsl-arch`).open();

    await waitFor(() => expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`));
    expect(document.body.textContent).toContain(`wsl -d Arch --exec sh -c "curl -fsSL https://intentic.dev/device |`);
    expect(document.body.textContent).toContain(`in PowerShell`);
    expect(document.body.textContent).not.toContain(`docker-desktop`);

    // The other way in stays one click away, for a reader already inside the distro.
    pill(`A terminal in the distro`).click();
    await waitFor(() => expect(document.body.textContent).not.toContain(`wsl -d Arch`));
    expect(document.body.textContent).toContain(`in a terminal`);
    fleet.value = [];
});

const facts = (hostname: string, distro?: string) => ({
    os: `Arch Linux`,
    arch: `x64`,
    shell: `/usr/bin/zsh`,
    home: `/home/radarsu`,
    roots: [],
    hostname,
    ...(distro === undefined ? {} : { wsl: { distro } }),
});
const connected = (id: string, hostFacts: ReturnType<typeof facts>): unknown => ({
    id,
    platform: `linux`,
    online: true,
    environments: [{ key: `native`, online: true, facts: hostFacts }],
    facts: hostFacts,
});

// A machine still called `linux-2` is offered its own hostname once it has said it; taking it is the rename the
// capability page would otherwise need a second dialog for, and the panel holds through the reconnect it causes.
it(`offers a card-named machine its hostname, and renames to it on a click`, async () => {
    document.body.innerHTML = ``;
    renamed.mockClear();
    onRenamed.mockClear();
    roster.value = [connected(`linux-2`, facts(`ROG-2024`, `archlinux`))];
    mount(`linux-2`, true).open();

    await waitFor(() => expect(document.body.textContent).toContain(`This machine calls itself`));
    // Slugged the way the Devices board joins a distro to its PC, lowercased since it becomes a tool prefix.
    expect(document.body.textContent).toContain(`rog-2024-wsl-archlinux`);

    pill(`Name it rog-2024-wsl-archlinux`).click();

    await waitFor(() => expect(renamed).toHaveBeenCalledWith({ id: `linux-2`, to: `rog-2024-wsl-archlinux` }));
    expect(onRenamed).toHaveBeenCalledWith(`rog-2024-wsl-archlinux`);
    await waitFor(() => expect(document.body.textContent).toContain(`Named rog-2024-wsl-archlinux`));
    expect(document.body.textContent).not.toContain(`This machine calls itself`);
    roster.value = [];
});

// A name the owner typed is theirs: `rog` differing from the hostname is not a reason to ask.
it(`leaves a machine the owner named alone`, async () => {
    document.body.innerHTML = ``;
    roster.value = [connected(`rog`, facts(`rog-2024`))];
    mount(`rog`, false).open();

    await waitFor(() => expect(document.body.textContent).toContain(`is connected`));
    expect(document.body.textContent).not.toContain(`This machine calls itself`);
    roster.value = [];
});
