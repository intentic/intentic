// @vitest-environment jsdom
// Mounts the vpn card over a live tunnel: filled from the connection not the card, states whose settings are on
// screen, and a credential never shown survives a save untouched.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/api-contract";
import { VAULTED } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";

// Import-time globals a mounted view needs: ui's useDevice reads matchMedia, environment.ts reads window.env.

// Which connection the form is over lives in the URL (`edit`), mirroring how the page reads the card off the path.
let query: Record<string, string> = {};
const replace = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card: `vpn` }, query }) as never,
    // `resolve` as well as `push`: a row's menu carries the address of what it opens (menuLink.ts).
    useRouter: () => ({ push: vi.fn(), replace, resolve: (to: string) => ({ href: to }) }) as never,
}));

// `secrets: ['config']` marks the WireGuard key as stored but withheld, distinguishing a real secret from an empty
// box.
const capabilities = ref<CapabilitySummary[]>([]);
const office = (): CapabilitySummary => ({
    id: `office`,
    kind: `vpn`,
    status: { state: `active` },
    config: { provider: `wireguard`, autoConnect: `on` },
    secrets: [`config`],
});

const add = vi.fn<(input: AddCapabilityInput) => Promise<void>>(async () => {});
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
vi.mock(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({ contributionOf: () => undefined, enabled: ref([]), extensions: ref([]), settled: ref(true) }),
}));
vi.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
vi.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
// VpnConnections dials as well as lists, so `error` must be present or the render throws.
vi.mock(`../sandbox/devices/useVpn`, () => ({
    importForticlient: vi.fn(),
    useVpn: () => ({ links: ref([]), error: ref(undefined), connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Capabilities } = await import("./Capabilities.vue");

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
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

const start = (editing: string | undefined): HTMLElement => {
    query = editing === undefined ? {} : { edit: editing };
    capabilities.value = [office()];
    add.mockClear();
    replace.mockClear();
    return mount();
};

// Submits the way the button does: Add is a PrimeVue component that dispatches this event.
const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await nextTick();
};

const nameBox = (el: HTMLElement): HTMLInputElement | null =>
    [...el.querySelectorAll(`label`)].find((label) => label.textContent?.startsWith(`Name`))?.querySelector(`input`) ?? null;
const wireguardBox = (el: HTMLElement): HTMLTextAreaElement => el.querySelector(`textarea`)!;

it(`opens a live connection's own settings, and says whose they are`, () => {
    const el = start(`office`);

    // Filled from the connection, not the card: the switch is where the user left it.
    expect(el.textContent).toContain(`Editing`);
    expect(el.textContent).toContain(`office`);
    // No name box: renaming is its own migration (see askRename), not a text field here.
    expect(nameBox(el)).toBeNull();
    // The button's word is the first thing to check before saving over a live connection.
    expect(el.textContent).toContain(`Save changes`);

    // Blank because it was never sent; the placeholder says so where the eye already is.
    expect(wireguardBox(el).value).toBe(``);
    expect(wireguardBox(el).placeholder).toContain(`already set`);
    expect(wireguardBox(el).placeholder).toContain(`leave blank to keep`);
});

it(`saves over the same connection and keeps the credential it was never shown`, async () => {
    const el = start(`office`);

    await submitForm(el);

    // Same id: an edit, not a second tunnel. VAULTED marks the kept key instead of an empty config.
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: `office`, kind: `vpn` }));
    expect(add.mock.calls[0]?.[0].config).toEqual({ provider: `wireguard`, config: VAULTED, autoConnect: `on` });
});

it(`replaces the credential when one is actually typed`, async () => {
    const el = start(`office`);

    const box = wireguardBox(el);
    box.value = `[Interface]\nPrivateKey = NEW\n`;
    box.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
    // A typed value is a value meant: the placeholder only covers a box left alone.
    expect(box.placeholder).not.toContain(`already set`);

    await submitForm(el);
    expect(add.mock.calls[0]?.[0].config[`config`]).toBe(`[Interface]\nPrivateKey = NEW`);
});

// Without `edit` the card is adding, as it always did; the name is pre-filled free (the card's id) so submit makes
// a second tunnel.
it(`still adds a second connection when no connection is being edited`, async () => {
    const el = start(undefined);

    expect(el.textContent).toContain(`Add another`);
    expect(el.textContent).not.toContain(`Editing`);
    expect(nameBox(el)?.value).toBe(`vpn`);
    // New name, nothing stored under it: the credential is a question again, not a promise.
    expect(wireguardBox(el).placeholder).not.toContain(`already set`);
});
