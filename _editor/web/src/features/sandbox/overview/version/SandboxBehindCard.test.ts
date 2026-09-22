// Pins the wording this card shows for a missing vs. a drifted route, and which side (if any) it blames.
// Two rules the words themselves must keep, both asserted below: nothing a reader sees is written in the vocabulary
// of whoever built this (no "route", "call", "contract", "daemon"), and nothing calls the sandbox's restart a
// RELOAD — that word belongs to the page, and blurring the two sends someone to press F5 at a stale sandbox.
// jsdom: mounts the component tree and reads rendered text.
import "@intentic/testing/dom";
import { type Device, SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { resetDaemonRoutes, setDaemonRoutes } from "../useDaemonRoutes";
import { resetContractFreshness } from "../contractFreshness";
import { IconStub } from "@intentic/ui/testing";

// Sandbox slug the printed restart command names, so it targets this machine's sandbox specifically, and the checkout
// the dev image was built from, which is the folder the restart runs in.
mock.module(`../../environment/useEnvironment`, () => ({
    useEnvironment: () => ({ slug: ref(`sandbox-abc123`), localImage: ref({ base: `intentic-sandbox:dev`, root: `/home/ada/intentic` }) }),
}));

// Whether the environment holding that checkout is a connected device, which is what decides between a button here
// and a command for someone to type out there. Evaluated when the card is first imported, below.
const hostId = ref<string | undefined>(undefined);
const severingCalls: string[] = [];
// The daemon's device list, which the card's fallback reads to find a machine already talking to this sandbox:
// empty stands for "nothing to offer", where only the command remains.
const fleet = ref<Device[]>([]);
mock.module(`../../devices/useDevices`, () => ({
    useHostHolding: () => hostId,
    useDevices: () => ({ devices: fleet, readAt: ref(0), error: ref(undefined), isLoading: ref(false), refetch: mock() }),
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
    // NO GLOBAL `Button` STUB. The card imports <Button> itself, so a stub here never reached one — but <Row>
    // builds its own headline as `<component :is="'button'">`, and Vue resolves that string against registered
    // components before falling back to the element. A component called `Button` therefore swallowed every row
    // header on this card, slots and all, and the rows rendered as empty buttons.
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
    expect(text).toContain(`Your sandbox is older than this page`);
    expect(text).toContain(`Your sandbox was built before these parts existed`);
    // The area reads as the product names it, with what the reader would be looking at when it bites.
    expect(text).toContain(`VPN`);
    expect(text).toContain(`this sandbox's VPN connection`);
    expect(text).toContain(`not available`);
    expect(text).not.toMatch(/reload this page/i);
    // The side something proves is behind, marked; never the count of internal endpoints, which means nothing here.
    expect(text).toContain(`older`);
    expect(text).not.toContain(`${LEVEL.length - withoutVpn.length} missing`);
});

// "Routes disagree" named the mechanism and nothing else. Both sides make the SAME calls here; what they can't agree
// on is what travels inside one — which is the whole reason a screen can look fine and still save nothing.
it(`refuses to name a side when only the payloads disagree`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`Some parts of this page may not work`);
    expect(text).toContain(`Sandbox settings`);
    expect(text).toContain(`everything on the Sandbox tabs`);
    expect(text).toContain(`may misbehave`);
    expect(text).not.toContain(`Your sandbox is older than this page`);
});

// The question the old card never answered: WHICH two programs. Each names itself, what it is, and how many calls
// it knows — the scale the disagreement count is read against.
it(`names both sides in words that don't assume you built this`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`This page`);
    expect(text).toContain(`the editor you're looking at, in this browser tab`);
    expect(text).toContain(`Your sandbox`);
    expect(text).toContain(`the machine running your code`);
    expect(text).toContain(`Everything else between them lines up.`);
});

// The vocabulary rule, enforced rather than trusted: these are the words that made two earlier versions of this card
// unreadable to everyone who had not written the contract. They may live in the evidence drawer, never in the report.
it(`says nothing in the vocabulary of whoever built it`, () => {
    setDaemonRoutes(withoutVpn, reshaped(`settings.get`));
    const text = mount().textContent ?? ``;
    for (const word of [`route`, `contract`, `daemon`, `endpoint`, `schema`, `payload`, `compiled`, `working tree`]) {
        expect(text.toLowerCase()).not.toContain(word);
    }
});

// The sandbox restarts; nothing on the card duplicates F5 as a button.
it(`never calls restarting the sandbox a reload`, () => {
    hostId.value = `ada-laptop`;
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Restart sandbox`);
    expect(text).not.toMatch(/reload (the )?sandbox/i);
    expect([...el.querySelectorAll(`button`)].map((button) => button.textContent)).not.toContain(`Reload page`);
});

// One shared schema reaches dozens of routes across areas that have nothing to do with each other; the card groups
// them into one feature row rather than naming each wire.
it(`groups many drifted routes into one feature row`, () => {
    const agentRoutes = Object.keys(SHAPES).filter((name) => name.startsWith(`agent.`));
    expect(agentRoutes.length).toBeGreaterThan(1);
    setDaemonRoutes(LEVEL, reshaped(...agentRoutes));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`Running a turn`);
    expect(text).toContain(`may misbehave`);
    expect(text).not.toMatch(/\d+ features? affected/);
});

// The dotted route names are the evidence, not the report: they used to be all the card said, and now they are what
// a chevron opens, under the sentence that says what that kind of gap costs.
it(`keeps the route names behind the row, with what the gap costs`, () => {
    const agentRoute = Object.keys(SHAPES).find((name) => name.startsWith(`agent.`));
    expect(agentRoute).toEqual(expect.any(String));
    setDaemonRoutes(LEVEL, reshaped(agentRoute!));
    const el = mount();
    expect(el.textContent ?? ``).not.toContain(agentRoute!);

    const row = [...el.querySelectorAll(`button[aria-expanded]`)].find((button) => button.textContent?.includes(`Running a turn`));
    expect(row).toEqual(expect.any(HTMLButtonElement));
    row?.dispatchEvent(new MouseEvent(`click`, { bubbles: true, detail: 1 }));
    return nextTick().then(() => {
        const text = el.textContent ?? ``;
        expect(text).toContain(agentRoute!);
        expect(text).toContain(`The two sides expect slightly different things here.`);
        expect(text).not.toContain(`Everything else works`);
        expect(text).not.toContain(`Still showing`);
    });
});

// The case the old threshold answered with silence: every route disagreeing is a different build, not a feature list.
// It is also the one case a row per area is a wall rather than a list, so the rows stand down to one sentence.
it(`calls a total disagreement one mismatch rather than naming every area`, () => {
    const allDifferent = Object.fromEntries(Object.keys(SHAPES).map((name) => [name, `different`]));
    setDaemonRoutes(LEVEL, allDifferent);
    const text = mount().textContent ?? ``;
    expect(text).toContain(`This page and your sandbox are far apart`);
    expect(text).toContain(`Nearly every part of the app is affected, so they aren't listed one by one.`);
    expect(text).toContain(`two quite different versions`);
    // Not forty rows of areas: the `where` line of one that would otherwise be listed.
    expect(text).not.toContain(`the file tree, the editor and search`);
});

// The dev case the card used to misdiagnose: this app bundles the contract from source, the sandbox loads it compiled,
// and an edit that has not been rebuilt looks exactly like two versions disagreeing.
it(`names an uncompiled contract as the cause`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    resetContractFreshness([`settings.get`]);
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Your sandbox hasn't picked up your latest changes`);
    expect(text).toContain(`Refreshing this page won't help`);
    expect(text).not.toContain(`Some parts of this page may not work`);
    expect([...el.querySelectorAll(`button`)].some((button) => button.textContent === `Reload page`)).toBe(false);
});

// A tab left open across a sandbox update: harmless on its own, and the one direction the old card could never name.
it(`names this page as the older side when the sandbox offers routes it has never heard of`, () => {
    setDaemonRoutes([...LEVEL, `future.feature`], reshaped(`settings.get`));
    expect(mount().textContent ?? ``).toContain(`This page is the older of the two.`);
});

// Each side holding routes the other lacks: two branches, not two points on one line, and no single reload fixes it.
it(`calls a two-way gap a fork rather than naming either side as behind`, () => {
    setDaemonRoutes([...withoutVpn, `future.feature`], SHAPES);
    const text = mount().textContent ?? ``;
    expect(text).toContain(`This page and your sandbox are from different versions`);
    expect(text).toContain(`neither one is simply newer`);
    // Both directions get a row of their own, since they are different failures: one feature is gone, one is unused.
    expect(text).toContain(`not available`);
    expect(text).toContain(`not used yet`);
    expect(text).not.toContain(`Your sandbox is older than this page`);
    expect(text).not.toContain(`This page is the older of the two.`);
});

it(`says nothing about a newer sandbox while the two still agree`, () => {
    setDaemonRoutes([...LEVEL, `future.feature`], SHAPES);
    expect(mount().textContent?.trim()).toBe(``);
});

it(`prints the restart for THIS sandbox, not an image rebuild, when nothing can reach that checkout`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`dev-restart.sh sandbox-abc123`);
    expect(text).not.toContain(`build:sandbox`);
    expect(el.querySelector(`.ui-code`)).not.toBeNull();
});

// The machine is connected, so the reload is ours to run: a button, and no command block to copy from.
it(`runs the reload on the device hosting this sandbox instead of printing it`, async () => {
    hostId.value = `ada-laptop`;
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const reload = [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Restart sandbox`);
    expect(reload).toEqual(expect.any(HTMLButtonElement));
    expect(el.textContent ?? ``).not.toContain(`dev-restart.sh`);
    expect(el.querySelector(`.ui-code`)).toBeNull();

    reload?.click();
    // The command name is the whole ask: the argv is the daemon's to build (hosts/device-commands.ts).
    expect(severingCalls).toEqual([`ada-laptop:dev-restart`]);
});

// Which machine runs this sandbox is read off the very payload a behind daemon disagrees about, so the button that
// fixes it must not be gated on that answer alone: one online device is the only machine it could be.
it(`reloads on the one connected device when nothing claims to run this sandbox`, async () => {
    fleet.value = [{ key: `ada-laptop`, label: `ada-laptop`, hostId: `ada-laptop`, online: true }];
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const reload = [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Restart sandbox`);
    reload?.click();
    expect(severingCalls).toEqual([`ada-laptop:dev-restart`]);
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
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Restart sandbox`)?.click();
    expect(severingCalls).toEqual([`rog-wsl:dev-restart`]);
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
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Restart sandbox`)?.click();
    expect(severingCalls).toEqual([`rog:dev-restart`]);
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
    expect([...el.querySelectorAll(`button`)].some((button) => button.textContent === `Restart sandbox`)).toBe(false);
    expect(el.textContent ?? ``).toContain(`dev-restart.sh sandbox-abc123`);
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
    expect(text).toContain(`dev-restart.sh sandbox-abc123`);
});

// Nothing to offer, so nothing is said: an invitation to connect a machine that isn't there is noise.
it(`says nothing about connecting when no machine syncs this sandbox`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    expect(mount().textContent ?? ``).not.toContain(`not connected as a device`);
});
