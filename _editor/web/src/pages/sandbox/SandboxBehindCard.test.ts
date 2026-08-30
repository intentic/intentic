// @vitest-environment jsdom
//
// jsdom because the subject is WORDING, and wording is the whole function of this card. It has no controls and
// no state of its own: it reads a disagreement between two builds and decides what to tell someone about it:
// which of the two is old, and what to run. Both of those were wrong before this file existed. The card
// asserted the sandbox was behind whatever the evidence said, and printed a full image rebuild as the remedy,
// which in dev cannot be the fix (the container reads its daemon from the working tree, so the image is never
// what predates a change). Neither mistake is visible in the code; both are plain in the rendered text.
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { resetDaemonRoutes, setDaemonRoutes } from "../../composables/sandbox/useDaemonRoutes";

// The one thing the card asks the daemon for: which sandbox it is looking at, so the command it prints names
// that one rather than leaving a dev machine running several to guess.
vi.mock(`../../composables/sandbox/useEnvironment`, () => ({
    useEnvironment: () => ({ slug: ref(`sandbox-abc123`) }),
}));

const { default: SandboxBehindCard } = await import("./SandboxBehindCard.vue");

// A daemon level with this browser, and the two ways it can disagree: a route it does not have (which names the
// daemon as the older side) and one it shapes differently (which names nobody).
const LEVEL = [...SANDBOX_ROUTE_NAMES];
const SHAPES = { ...SANDBOX_ROUTE_SHAPES };
const withoutVpn = LEVEL.filter((name) => !name.startsWith(`vpn.`));
const reshaped = (name: string): Record<string, string> => ({ ...SHAPES, [name]: `different` });

let app: App | undefined;

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxBehindCard) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
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
    // Direction is known here, so nothing hedges: a page reload would not bring a route back.
    expect(text).not.toMatch(/reload this page/i);
});

it(`refuses to name a side when only the payloads disagree`, () => {
    /* The failure this card was reported for: a sandbox rebuilt minutes earlier, still told it was behind, with
     * a rebuild as the cure. Drift is symmetric evidence: a tab open since before the change is as likely to
     * be the stale one, so the heading states the disagreement and the page is offered as the other suspect. */
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
    // In dev the daemon runs the working tree's compiled output, so restarting it is the fix and a rebuild is
    // minutes spent reaching the same place. The slug is what keeps a machine running several sandboxes from
    // reloading the wrong one.
    setDaemonRoutes(LEVEL, reshaped(`settings.get`));
    const el = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`dev-reload.sh sandbox-abc123`);
    expect(text).not.toContain(`build:sandbox`);
    expect(el.querySelector(`.ui-code`)).not.toBeNull();
});
