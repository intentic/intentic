// @vitest-environment jsdom
// Pins the wording this card shows for a missing vs. a drifted route, and which side (if any) it blames.
// jsdom: mounts the component tree and reads rendered text.
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { resetDaemonRoutes, setDaemonRoutes } from "./useDaemonRoutes";
import { IconStub } from "@intentic/ui/testing";

// Sandbox slug the printed reload command names, so it targets this machine's sandbox specifically.
vi.mock(`../environment/useEnvironment`, () => ({
    useEnvironment: () => ({ slug: ref(`sandbox-abc123`) }),
}));

// Whether the machine this sandbox runs on is a connected device, which is what decides between a button here and a
// command for someone to type out there. Evaluated when the card is first imported, below.
const hostId = ref<string | undefined>(undefined);
const severingCalls: string[] = [];
vi.mock(`../devices/useDevices`, () => ({
    useHostRunning: () => hostId,
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
const reshaped = (name: string): Record<string, string> => ({ ...SHAPES, [name]: `different` });

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
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

beforeEach(() => {
    resetDaemonRoutes();
    hostId.value = undefined;
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
    expect(text).toContain(`Settings may show blank values or fail to save.`);
    expect(text).not.toContain(`Sandbox is behind the app`);
    expect(text).toMatch(/reload page/i);
});

it(`keeps the warning to the problem, impact, and fixes`, () => {
    const agentRoute = Object.keys(SHAPES).find((name) => name.startsWith(`agent.`));
    expect(agentRoute).toEqual(expect.any(String));
    setDaemonRoutes(LEVEL, reshaped(agentRoute!));
    const text = mount().textContent ?? ``;
    expect(text).toContain(`Agent may show blank values or fail to save.`);
    expect(text).not.toContain(`Everything else works`);
    expect(text).not.toContain(`1 changed`);
    expect(text).not.toContain(`Still showing`);
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
