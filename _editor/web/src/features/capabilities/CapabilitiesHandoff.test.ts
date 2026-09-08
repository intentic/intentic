// @vitest-environment jsdom
// An add that ends pending has not finished; the remaining step (a one-liner, a login, a rebuild) is named on the
// card just filled in. These pin what stays on screen for each of the three.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilityStatus, CapabilitySummary } from "@intentic/api-contract";
import { IconStub } from "@intentic/ui/testing";

// Import-time globals a mounted view needs: ui's useDevice reads matchMedia, environment.ts reads window.env.

// Which card the page is on, read once at setup since the page is URL-driven and nothing here navigates.
let card = `linux`;
const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card }, query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// Both cards are contributed, not static; a device's permission switches come from the catalog, not the manifest.
vi.mock(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({
        contributionOf: () => undefined,
        extensions: ref([]),
        settled: ref(true),
        enabled: ref([
            {
                id: `intentic.devices`,
                manifest: {
                    contributes: {
                        capabilities: [
                            {
                                id: `linux`,
                                kind: `host`,
                                catalog: { name: `Linux PC`, category: `devices`, description: `Let the agent work on your Linux device.` },
                                fields: [],
                            },
                        ],
                    },
                },
            },
            {
                id: `intentic.social`,
                manifest: {
                    contributes: {
                        capabilities: [
                            {
                                id: `reddit`,
                                kind: `browser`,
                                catalog: { name: `Reddit`, category: `social`, description: `Let the agent act as you on Reddit.` },
                                fields: [],
                            },
                        ],
                    },
                },
            },
        ]),
    }),
}));

// `add` writes what the daemon would write; each test sets the status its handler would report, which the page
// then reads.
const capabilities = ref<CapabilitySummary[]>([]);
let applied: CapabilityStatus = { state: `pending` };
const add = vi.fn<(input: AddCapabilityInput) => Promise<void>>(async (input) => {
    capabilities.value = [
        ...capabilities.value,
        { id: input.id, kind: card === `linux` ? `host` : `browser`, status: applied, config: input.config, secrets: [] },
    ];
});
vi.mock(`./connect/useCapabilities`, () => ({
    useCapabilities: () => ({
        hasCapability: () => true,
        recommendationFor: () => undefined,
        capabilities,
        error: ref(undefined),
        add: (input: AddCapabilityInput) => add(input),
        remove: { mutateAsync: vi.fn(), isPending: ref(false) },
        rename: { mutateAsync: vi.fn(), isPending: ref(false) },
        refetch: vi.fn(),
        dismissRecommendation: { mutateAsync: vi.fn(), isPending: ref(false) },
    }),
    browseMarketplace: vi.fn(),
}));
// Extension card's signpost reads the registry cache; nothing here has browsed it.
vi.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
vi.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
// No machine has checked in, matching a just-added device.
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
// VpnConnections dials as well as lists, so `error` must be present or the render throws.
vi.mock(`../sandbox/devices/useVpn`, () => ({
    importForticlient: vi.fn(),
    useVpn: () => ({ links: ref([]), error: ref(undefined), connect: vi.fn(), disconnect: vi.fn() }),
}));
// The two dialogs mint real credentials against a daemon; the stubs render only what's open and on what.
vi.mock(`./connect/HostConnectDialog.vue`, () => ({
    default: defineComponent({
        props: { visible: Boolean, id: String, platform: String, permissions: String },
        render() {
            return this.visible ? h(`div`, { "data-connect": this.id, "data-platform": this.platform }, this.permissions) : null;
        },
    }),
}));
vi.mock(`./connect/BrowserProfileDialog.vue`, () => ({
    default: defineComponent({
        props: { visible: Boolean, capability: String, label: String, mode: String },
        render() {
            // Records both the mode and the connection: a hand-off must land on the right step and the right account.
            return this.visible ? h(`div`, { "data-browser": this.capability, "data-mode": this.mode }, this.label) : null;
        },
    }),
}));

const { default: Capabilities } = await import("./Capabilities.vue");

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
    // RouterLink stub, since the real router plugin isn't mounted; `href` stays since one test checks where a row
    // leads.
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: String },
            setup:
                (props, { slots }) =>
                () =>
                    h(`a`, { href: props.to }, slots["default"]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// Submits the way the button does: Add is a PrimeVue component that dispatches this event.
const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await nextTick();
};

const start = (onCard: string, status: CapabilityStatus): HTMLElement => {
    card = onCard;
    applied = status;
    capabilities.value = [];
    add.mockClear();
    push.mockClear();
    return mount();
};

it(`hands over the machine's command when a device is added, instead of returning to the catalog`, async () => {
    const el = start(`linux`, { state: `pending`, detail: `click Connect and run the one-liner on that device` });

    await submitForm(el);

    // Opened on the just-created machine: the suggested name and the card's platform.
    const dialog = el.querySelector(`[data-connect]`);
    expect(dialog?.getAttribute(`data-connect`)).toBe(`linux`);
    expect(dialog?.getAttribute(`data-platform`)).toBe(`linux`);
    // Grant stated is whatever the switches were left on, not a fixed sentence.
    expect(dialog?.textContent).toContain(`run commands`);
    expect(push).not.toHaveBeenCalled();
});

it(`opens the sign-in window when a browser account is added and the login is what is missing`, async () => {
    const el = start(`reddit`, { state: `pending`, detail: `log in to connect your account` });

    await submitForm(el);

    const window = el.querySelector(`[data-browser]`);
    expect(window?.getAttribute(`data-browser`)).toBe(`reddit`);
    expect(window?.getAttribute(`data-mode`)).toBe(`login`);
    expect(push).not.toHaveBeenCalled();
});

// Same card, pending on the other thing: no browser is installed yet, so the remedy is a rebuild elsewhere.
it(`does not open the sign-in window when the browser is still waiting on a rebuild`, async () => {
    const el = start(`reddit`, { state: `pending`, detail: `rebuild the sandbox to install the browser (Environment card)` });

    await submitForm(el);

    expect(el.querySelector(`[data-browser]`)).toBeNull();
    // Still no navigation: the row naming the rebuild lives on the card.
    expect(push).not.toHaveBeenCalled();
    // Names it and leads to it in two halves: the status badge is the daemon's words, the link beside it goes to the
    // remedy.
    const link = [...el.querySelectorAll(`a`)].find((anchor) => anchor.getAttribute(`href`) === `/sandbox/environment`);
    expect(link).toEqual(expect.any(Object));
    expect(el.textContent).toContain(`rebuild the sandbox to install the browser`);
});

// An apply that finished has nothing left to hand over, so it returns to the catalog.
it(`returns to the catalog when the capability came back active`, async () => {
    const el = start(`reddit`, { state: `active` });

    await submitForm(el);

    expect(el.querySelector(`[data-browser]`)).toBeNull();
    expect(push).toHaveBeenCalledTimes(1);
});

// A connected account isn't finished with: the same row also opens the signed-in browser itself, in browse mode
// instead of login.
it(`offers the connected browser to be used, not only signed into again`, async () => {
    const el = start(`reddit`, { state: `active` });
    await submitForm(el);

    const open = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Open browser`));
    open?.click();
    await nextTick();

    const window = el.querySelector(`[data-browser]`);
    expect(window?.getAttribute(`data-browser`)).toBe(`reddit`);
    expect(window?.getAttribute(`data-mode`)).toBe(`browse`);
});

// One site, two accounts: every row's button must act on that row's own signed-in browser, not whichever account
// is first.
it(`opens the account a row belongs to when one site is connected twice`, async () => {
    card = `reddit`;
    applied = { state: `active` };
    capabilities.value = [{ id: `reddit`, kind: `browser`, status: { state: `active` }, config: { platform: `reddit` }, secrets: [] }];
    add.mockClear();
    push.mockClear();
    const el = mount();

    // Form pre-fills a free name over the taken one, so submit adds a second account instead of overwriting the first.
    await submitForm(el);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: `reddit-2` }));

    // Two rows in list order; the second row's button opens the second account.
    const opens = [...el.querySelectorAll(`button`)].filter((button) => button.textContent?.includes(`Open browser`));
    expect(opens).toHaveLength(2);
    opens[1]!.click();
    await nextTick();

    const window = el.querySelector(`[data-browser]`);
    expect(window?.getAttribute(`data-browser`)).toBe(`reddit-2`);
    // Names the account, not the card: two windows on one site must be tellable apart.
    expect(window?.textContent).toBe(`reddit-2`);
});

it(`leaves the form on screen with the failure when the apply fails, offering no command`, async () => {
    const el = start(`linux`, { state: `pending` });
    add.mockRejectedValueOnce(new Error(`no host platform "linux"`));

    await submitForm(el);

    expect(el.textContent).toContain(`no host platform "linux"`);
    expect(el.querySelector(`[data-connect]`)).toBeNull();
    expect(push).not.toHaveBeenCalled();
});
