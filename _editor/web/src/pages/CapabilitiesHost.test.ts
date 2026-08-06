// @vitest-environment jsdom
//
// ADDING A COMPUTER IS HALF A STEP. The other half runs on the machine itself, and the card is the only place
// its one-time command exists — so the add has to land ON that command. It used to navigate back to the
// catalog instead, which left the reader in front of a grid, a capability that had quietly gone `pending`, and
// nothing at all saying what to do next. That is what these pin: what is on screen when the apply finishes.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { AddCapabilityInput } from "@intentic-app/capability-catalog";
import type { CapabilitySummary } from "@intentic-app/api-contract";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card: `linux` }, query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// The computer cards are CONTRIBUTED, not static — there is no `linux` entry in the catalog to route to unless
// an enabled extension declares one. This is the computers extension's manifest narrowed to what a card needs.
vi.mock(`../composables/extensions/useExtensions`, () => ({
    useExtensions: () => ({
        contributionOf: () => undefined,
        extensions: ref([]),
        settled: ref(true),
        enabled: ref([
            {
                id: `intentic.computers`,
                manifest: {
                    contributes: {
                        capabilities: [
                            {
                                id: `linux`,
                                kind: `host`,
                                catalog: { name: `Linux PC`, category: `machines`, description: `Let the agent work on your Linux computer.` },
                                fields: [],
                            },
                        ],
                    },
                },
            },
        ]),
    }),
}));

// The apply, and the list it lands in. `add` writes the instance the daemon would have written, because what
// the page does next is read off that list — an add that "succeeded" into an empty list is the one case where
// there is nothing to open a command for.
const capabilities = ref<CapabilitySummary[]>([]);
const add = vi.fn<(input: AddCapabilityInput) => Promise<void>>(async (input) => {
    capabilities.value = [...capabilities.value, { id: input.id, kind: `host`, status: { state: `pending` }, config: input.config }];
});
vi.mock(`../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({
        hasCapability: () => true,
        recommendationFor: () => undefined,
        capabilities,
        error: ref(undefined),
        add: (input: AddCapabilityInput) => add(input),
        remove: { mutateAsync: vi.fn(), isPending: ref(false) },
        refetch: vi.fn(),
    }),
    browseMarketplace: vi.fn(),
}));
vi.mock(`../composables/terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
vi.mock(`../composables/sandbox/useVpn`, () => ({ importForticlient: vi.fn(), useVpn: () => ({ links: ref([]) }) }));
vi.mock(`../components/BrowserLoginDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// The real dialog mints a pairing token against a daemon. What matters here is only that it is open, on which
// machine, and with which grant — so the stub renders exactly that and nothing else.
vi.mock(`../components/HostConnectDialog.vue`, () => ({
    default: defineComponent({
        props: { visible: Boolean, id: String, platform: String, permissions: String },
        render() {
            return this.visible ? h(`div`, { "data-connect": this.id, "data-platform": this.platform }, this.permissions) : null;
        },
    }),
}));

const { default: Capabilities } = await import("./Capabilities.vue");

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
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

// The card's own form, submitted the way the button submits it — the Add button is a PrimeVue component and
// what it does is dispatch this.
const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    await nextTick();
};

it(`hands over the machine's command when the computer is added, instead of returning to the catalog`, async () => {
    capabilities.value = [];
    add.mockClear();
    push.mockClear();
    const el = mount();

    await submitForm(el);

    // Opened on the machine that was just created — the name the form suggested, and the platform the card pins.
    const dialog = el.querySelector(`[data-connect]`);
    expect(dialog?.getAttribute(`data-connect`)).toBe(`linux`);
    expect(dialog?.getAttribute(`data-platform`)).toBe(`linux`);
    // The grant the dialog states is the one the switches were left on, not a fixed sentence.
    expect(dialog?.textContent).toContain(`run commands`);
    // And the card stayed put: navigating back is what used to strand the reader.
    expect(push).not.toHaveBeenCalled();
});

it(`leaves the form on screen with the failure when the apply fails, offering no command`, async () => {
    capabilities.value = [];
    add.mockClear();
    push.mockClear();
    add.mockRejectedValueOnce(new Error(`no host platform "linux"`));
    const el = mount();

    await submitForm(el);

    expect(el.textContent).toContain(`no host platform "linux"`);
    expect(el.querySelector(`[data-connect]`)).toBeNull();
    expect(push).not.toHaveBeenCalled();
});
