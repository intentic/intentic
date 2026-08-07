// @vitest-environment jsdom
//
// AN ADD THAT ENDS `pending` HAS NOT FINISHED. The remaining step differs by kind — a machine's one-liner, a
// browser's login, a sandbox rebuild — but it is named on the card the user just filled in, and the form used
// to navigate away from it the moment the apply succeeded. That left the reader on the catalog grid with a
// capability quietly gone pending and nothing on screen saying what to do. These pin what is on screen when
// the apply finishes, for each of the three.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { AddCapabilityInput } from "@intentic-app/capability-catalog";
import type { CapabilityStatus, CapabilitySummary } from "@intentic-app/api-contract";

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

// Which card the page is on. Read once during setup, so setting it before mount is enough — the page is
// URL-driven and nothing here navigates.
let card = `linux`;
const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card }, query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// Both cards are CONTRIBUTED, not static — there is no `linux` or `reddit` entry in the catalog to route to
// unless an enabled extension declares one. These are the computers and social manifests narrowed to what a
// card needs; the permission switches a computer carries are added by the catalog itself, not by the manifest.
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

/* The apply, and the list it lands in. `add` writes the instance the daemon would have written, because what
 * the page does next is read off that list and off the STATUS its handler reported — which is the whole
 * subject here. Each test sets the status that handler would have returned. */
const capabilities = ref<CapabilitySummary[]>([]);
let applied: CapabilityStatus = { state: `pending` };
const add = vi.fn<(input: AddCapabilityInput) => Promise<void>>(async (input) => {
    capabilities.value = [
        ...capabilities.value,
        { id: input.id, kind: card === `linux` ? `host` : `browser`, status: applied, config: input.config },
    ];
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
        dismissRecommendation: { mutateAsync: vi.fn(), isPending: ref(false) },
    }),
    browseMarketplace: vi.fn(),
}));
vi.mock(`../composables/terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
// No machine has ever checked in, which is what a just-added computer looks like.
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
vi.mock(`../composables/sandbox/useVpn`, () => ({ importForticlient: vi.fn(), useVpn: () => ({ links: ref([]) }) }));
// The two dialogs mint real credentials against a daemon. What matters here is only that one is open and on
// what — so the stubs render that and nothing else.
vi.mock(`../components/HostConnectDialog.vue`, () => ({
    default: defineComponent({
        props: { visible: Boolean, id: String, platform: String, permissions: String },
        render() {
            return this.visible ? h(`div`, { "data-connect": this.id, "data-platform": this.platform }, this.permissions) : null;
        },
    }),
}));
vi.mock(`../components/BrowserProfileDialog.vue`, () => ({
    default: defineComponent({
        props: { visible: Boolean, platform: String, label: String, mode: String },
        render() {
            // One window, two jobs — so the stub records WHICH one it was opened for: a hand-off that landed on
            // the browse mode would be pointing at the wrong step.
            return this.visible ? h(`div`, { "data-browser": this.platform, "data-mode": this.mode }, this.label) : null;
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
    // Registered app-wide by the router plugin in the real app, which this mount deliberately does without.
    // `href` is kept because one of these tests is about WHERE a row leads.
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

// The card's own form, submitted the way the button submits it — the Add button is a PrimeVue component and
// what it does is dispatch this.
const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
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

it(`hands over the machine's command when a computer is added, instead of returning to the catalog`, async () => {
    const el = start(`linux`, { state: `pending`, detail: `click Connect and run the one-liner on that computer` });

    await submitForm(el);

    // Opened on the machine that was just created — the name the form suggested, and the platform the card pins.
    const dialog = el.querySelector(`[data-connect]`);
    expect(dialog?.getAttribute(`data-connect`)).toBe(`linux`);
    expect(dialog?.getAttribute(`data-platform`)).toBe(`linux`);
    // The grant the dialog states is the one the switches were left on, not a fixed sentence.
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

// The same card, pending on the OTHER thing. Opening the login here would point at the wrong step: there is no
// browser installed to sign into yet, and the remedy is a rebuild on another screen.
it(`does not open the sign-in window when the browser is still waiting on a rebuild`, async () => {
    const el = start(`reddit`, { state: `pending`, detail: `rebuild the sandbox to install the browser (Environment card)` });

    await submitForm(el);

    expect(el.querySelector(`[data-browser]`)).toBeNull();
    // Still no navigation: the card is where the row that names the rebuild — and leads to it — lives.
    expect(push).not.toHaveBeenCalled();
    const link = [...el.querySelectorAll(`a`)].find((anchor) => anchor.getAttribute(`href`) === `/sandbox/environment`);
    expect(link?.textContent).toContain(`rebuild the sandbox to install the browser`);
});

// The other half of the rule: an apply that actually finished has nothing left to hand over, and the catalog
// is the right place to land.
it(`returns to the catalog when the capability came back active`, async () => {
    const el = start(`reddit`, { state: `active` });

    await submitForm(el);

    expect(el.querySelector(`[data-browser]`)).toBeNull();
    expect(push).toHaveBeenCalled();
});

// A connected account is not finished with. The row that offers a re-log-in also offers the browser ITSELF —
// the same signed-in profile the agent uses, for the user to do something in by hand — and the difference
// between the two is the mode the window opens in, not a second browser.
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

it(`leaves the form on screen with the failure when the apply fails, offering no command`, async () => {
    const el = start(`linux`, { state: `pending` });
    add.mockRejectedValueOnce(new Error(`no host platform "linux"`));

    await submitForm(el);

    expect(el.textContent).toContain(`no host platform "linux"`);
    expect(el.querySelector(`[data-connect]`)).toBeNull();
    expect(push).not.toHaveBeenCalled();
});
