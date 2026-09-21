// @vitest-environment jsdom
// Pins the wording this card shows for a missing vs. a drifted route, and which side (if any) it blames.
// jsdom: mounts the component tree and reads rendered text.
import { type Device, SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { resetDaemonRoutes, setDaemonRoutes } from "../useDaemonRoutes";
import { resetContractFreshness } from "../contractFreshness";
import { IconStub } from "@intentic/ui/testing";

// Sandbox slug the printed reload command names, so it targets this machine's sandbox specifically, and the checkout
// the dev image was built from, which is the folder the reload runs in.
vi.mock(`../../environment/useEnvironment`, () => ({
    useEnvironment: () => ({ slug: ref(`sandbox-abc123`), localImage: ref({ base: `intentic-sandbox:dev`, root: `/home/ada/intentic` }) }),
}));

// Whether the environment holding that checkout is a connected device, which is what decides between a button here
// and a command for someone to type out there. Evaluated when the card is first imported, below.
const hostId = ref<string | undefined>(undefined);
const severingCalls: string[] = [];
// The daemon's device list, which the card's fallback reads to find a machine already talking to this sandbox:
// empty stands for "nothing to offer", where only the command remains.
const fleet = ref<Device[]>([]);
vi.mock(`../../devices/useDevices`, () => ({
    useHostHolding: () => hostId,
    useDevices: () => ({ devices: fleet, readAt: ref(0), error: ref(undefined), isLoading: ref(false), refetch: vi.fn() }),
    runSeveringDeviceCommand: (id: string, command: string) => {
        severingCalls.push(`${id}:${command}`);
        return Promise.resolve(undefined);
    },
}));

const { default: SandboxBehindCard } = await import("./SandboxBehindCard.vue");

// Baseline daemon level, plus the two ways it can diverge: a missing route, or one with a different shape.
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const SHAPES = { ...SANDBOX_ROUTE_SHAPES };
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));
const reshaped = (...names: string[]): Record<string, string> => ({ ...SHAPES, ...Object.fromEntries(names.map((name) => [name, `different`])) });

let app: App | undefined;

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxBehindCard) });
    app.component(`Icon`, IconStub);
    app.component(
        `Button`,
        defineComponent({
            props: { label: String },
            setup: (props) => () => h(`button`, props.label),
        }),
    );
    // Registered app-wide by the router plugin in the real app; the connect offer below is a link.
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

beforeEach(() => {
    resetDaemonRoutes();
    // Reset to "the dev server hasn't answered", so only the test that asks for it sees an uncompiled contract.
    resetContractFreshness();
    hostId.value = undefined;
    fleet.value = [];
    severingCalls.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

it(`says nothing at all while the two builds agree`, () => {
    setDaemonRoutes(LEVEL, SHAPES);
    expect(mount().textContent?.trim()).toBe(``);
});

it(`names the sandbox as behind only when a missing route proves it`, () => {
    setDaemonRoutes(withoutVpn, SHAPES);
    const text = mount().textContent ?? ``;
    expect(text).toContain(`Sandbox is behind the app`);
    expect(text).toContain(`VPN won't work until the sandbox is reloaded.`);
    expect(text).not.toMatch(/reload this page/i);
});

it(`refuses to name a side when only the payloads disagree`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`App and sandbox are out of sync`);
    expect(text).toContain(`1 route disagrees (Settings); it may show blank values or fail to save.`);
    expect(text).not.toContain(`Sandbox is behind the app`);
    expect(text).toMatch(/reload page/i);
});

// One shared schema reaches dozens of routes across areas that have nothing to do with each other, so the area list
// alone reads as that many separate things being broken. The count is what tells those apart.
it(`counts the drifted routes, not just the areas they land in`, () => {
    const agentRoutes = Object.keys(SHAPES).filter((name) => name.startsWith(`agent.`));
    expect(agentRoutes.length).toBeGreaterThan(1);
    setDaemonRoutes(LEVEL, reshaped(...agentRoutes));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`${agentRoutes.length} routes disagree (Agent); they may show blank values or fail to save.`);
});

it(`keeps the warning to the problem, impact, and fixes`, () => {
    const agentRoute = Object.keys(SHAPES).find((name) => name.startsWith(`agent.`));
    expect(agentRoute).toEqual(expect.any(String));
    setDaemonRoutes(LEVEL, reshaped(agentRoute!));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`1 route disagrees (Agent); it may show blank values or fail to save.`);
    expect(text).not.toContain(`Everything else works`);
    expect(text).not.toContain(`Still showing`);
});

// The case the old threshold answered with silence: every route disagreeing is a different build, not a feature list.
it(`calls a total disagreement one mismatch rather than naming every area`, () => {
    const allDifferent = Object.fromEntries(Object.keys(SHAPES).map((name) => [name, `different`]));
    setDaemonRoutes(LEVEL, allDifferent);
    const text = mount().textContent ?? ``;
    expect(text).toContain(`App and sandbox are running different contracts`);
    expect(text).toContain(`${Object.keys(SHAPES).length} of ${Object.keys(SHAPES).length} routes disagree`);
    expect(text).toContain(`different builds rather than one changed field`);
});

// The dev case the card used to misdiagnose: this app bundles the contract from source, the sandbox loads it compiled,
// and an edit that has not been rebuilt looks exactly like two versions disagreeing.
it(`names an uncompiled contract as the cause and withholds the page reload`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    resetContractFreshness([`settings.get`]);
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Sandbox is running an older compiled contract`);
    expect(text).toContain(`1 route differs`);
    expect(text).toContain(`Reloading this page won't help.`);
    expect(text).not.toContain(`App and sandbox are out of sync`);
    expect([...el.querySelectorAll(`button`)].some((button) => button.textContent === `Reload page`)).toBe(false);
});

// A tab left open across a sandbox update: harmless on its own, and the one direction the old card could never name.
it(`names this page as the older side when the sandbox offers routes it has never heard of`, () => {
    setDaemonRoutes([...LEVEL, `future.feature`], reshaped(`settings.get`));
    expect(mount().textContent ?? ``).toContain(`This page is older than the sandbox.`);
});

// Each side holding routes the other lacks: two branches, not two points on one line, and no single reload fixes it.
it(`calls a two-way gap a fork rather than naming either side as behind`, () => {
    setDaemonRoutes([...withoutVpn, `future.feature`], SHAPES);
    const text = mount().textContent ?? ``;
    expect(text).toContain(`App and sandbox are on different builds`);
    expect(text).toContain(`VPN won't work here, and the sandbox offers 1 route this page doesn't know`);
    expect(text).toContain(`neither side is simply older`);
    expect(text).not.toContain(`Sandbox is behind the app`);
    expect(text).not.toContain(`This page is older than the sandbox.`);
});

it(`says nothing about a newer sandbox while the two still agree`, () => {
    setDaemonRoutes([...LEVEL, `future.feature`], SHAPES);
    expect(mount().textContent?.trim()).toBe(``);
});

it(`prints the reload for THIS sandbox, not an image rebuild, when nothing can reach that checkout`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`dev-reload.sh sandbox-abc123`);
    expect(text).not.toContain(`build:sandbox`);
    expect(el.querySelector(`.ui-code`)).not.toBeNull();
});

// The machine is connected, so the reload is ours to run: a button, and no command block to copy from.
it(`runs the reload on the device hosting this sandbox instead of printing it`, async () => {
    hostId.value = `ada-laptop`;
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const reload = [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Reload sandbox`);
    expect(reload).toEqual(expect.any(HTMLButtonElement));
    expect(el.textContent ?? ``).not.toContain(`dev-reload.sh`);
    expect(el.querySelector(`.ui-code`)).toBeNull();

    reload?.click();
    // The command name is the whole ask: the argv is the daemon's to build (hosts/device-commands.ts).
    expect(severingCalls).toEqual([`ada-laptop:dev-reload`]);
});

// Which machine runs this sandbox is read off the very payload a behind daemon disagrees about, so the button that
// fixes it must not be gated on that answer alone: one online device is the only machine it could be.
it(`reloads on the one connected device when nothing claims to run this sandbox`, async () => {
    fleet.value = [{ key: `ada-laptop`, label: `ada-laptop`, hostId: `ada-laptop`, online: true }];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const reload = [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Reload sandbox`);
    reload?.click();
    expect(severingCalls).toEqual([`ada-laptop:dev-reload`]);
});

// One PC answering through two doors folds to one machine, so the fallback above is offered — but the reload is a
// `sh` script inside the distro's own filesystem, and the Windows door would hand it to PowerShell.
it(`reloads through the distro's door, not the Windows side of the same PC`, () => {
    const facts = { arch: `x64`, roots: [], hostname: `rog` };
    fleet.value = [
        {
            key: `rog`,
            label: `rog`,
            hostId: `rog`,
            online: true,
            platform: `windows`,
            facts: { ...facts, os: `Microsoft Windows 11 Home`, shell: `PowerShell 7`, home: `C:\\Users\\ada` },
        },
        {
            key: `rog-wsl`,
            label: `rog-wsl`,
            hostId: `rog-wsl`,
            online: true,
            platform: `linux`,
            facts: { ...facts, os: `Arch Linux`, shell: `/usr/bin/zsh`, home: `/home/ada`, wsl: { distro: `Arch` } },
        },
    ];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Reload sandbox`)?.click();
    expect(severingCalls).toEqual([`rog-wsl:dev-reload`]);
});

// The machine is connected; which of its shells the owner connected it through is not the reader's problem. The
// daemon crosses into the distro from the Windows door, so the button is offered rather than withheld.
it(`offers the reload on a PC connected only on its Windows side`, () => {
    fleet.value = [
        {
            key: `rog`,
            label: `rog`,
            hostId: `rog`,
            online: true,
            platform: `windows`,
            facts: { os: `Microsoft Windows 11 Home`, arch: `x64`, shell: `PowerShell 7`, home: `C:\\Users\\ada`, roots: [], hostname: `rog` },
        },
    ];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Reload sandbox`)?.click();
    expect(severingCalls).toEqual([`rog:dev-reload`]);
});

// Two machines and no reading of which holds this container is a guess, and a reload aimed at the wrong one is a
// restart somebody didn't ask for; the command goes back on screen instead.
it(`prints the command rather than choosing between two connected devices`, () => {
    fleet.value = [
        { key: `ada-laptop`, label: `ada-laptop`, hostId: `ada-laptop`, online: true },
        { key: `guest`, label: `guest`, hostId: `guest`, online: true },
    ];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    expect([...el.querySelectorAll(`button`)].some((button) => button.textContent === `Reload sandbox`)).toBe(false);
    expect(el.textContent ?? ``).toContain(`dev-reload.sh sandbox-abc123`);
});

// The case the command block was hiding: a machine is already syncing this sandbox, so the reason there is no
// button is a card away, and saying so is worth more than the command it sits under.
it(`offers to connect the machine already syncing this sandbox`, () => {
    fleet.value = [
        {
            key: `radarsu-rog`,
            label: `radarsu-rog`,
            platform: `linux`,
            sync: { machine: `radarsu-rog`, mode: `sync` },
            report: {
                hostname: `radarsu-rog`,
                os: `linux`,
                // Keyed as the sync agent keys it, which is docker's slug plus the zone.
                pairings: [{ sandboxId: `sandbox-abc123-fra`, mode: `sync`, localDir: `/home/ada/work` }],
                ports: [],
                agent: { running: true },
                capturedAt: 0,
            },
        },
    ];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`radarsu-rog`);
    expect(text).toContain(`syncs this sandbox but is not connected as a device`);
    // The command stays: connecting is an offer, not a precondition for getting out of this state now.
    expect(text).toContain(`dev-reload.sh sandbox-abc123`);
});

// Nothing to offer, so nothing is said: an invitation to connect a machine that isn't there is noise.
it(`says nothing about connecting when no machine syncs this sandbox`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    expect(mount().textContent ?? ``).not.toContain(`not connected as a device`);
});
