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

beforeEach(() => resetDaemonRoutes());

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

it(`prints the reload for THIS sandbox, not an image rebuild`, () => {
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`dev-reload.sh sandbox-abc123`);
    expect(text).not.toContain(`build:sandbox`);
    expect(el.querySelector(`.ui-code`)).not.toBeNull();
});
