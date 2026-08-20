// @vitest-environment jsdom
//
// CHANGING A CONNECTION YOU ALREADY HAVE. The card's form was only ever an ADD form: it opened pre-filled with
// the card's defaults and a free name, and the only way to reach a live connection's settings was to notice a
// line of small print and re-type its name exactly. So in practice a wrong gateway or a wrong routed network
// meant removing the connection and building it again — which for a signed-in account, a paired machine or a
// tunnel throws away the very thing that makes it worth keeping.
//
// These mount the vpn card over a LIVE tunnel and pin the three things that make the same form safe to edit
// with: it is filled from that connection rather than from the card, it says whose settings are on screen, and
// the credential it was never shown survives a save untouched.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { AddCapabilityInput } from "@intentic-app/capability-catalog";
import type { CapabilitySummary } from "@intentic-app/api-contract";
import { VAULTED } from "@intentic/sandbox-contract";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.

/* WHICH CONNECTION THE FORM IS OVER LIVES IN THE URL, next to the card — so a reload lands back on it and Back
 * leaves the edit rather than the page. The mock is a real query rather than an empty one for that reason: the
 * page reads `edit` off the route exactly as it reads the card off the path. */
let query: Record<string, string> = {};
const replace = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card: `vpn` }, query }) as never,
    // `resolve` as well as `push`: a row's menu now carries the ADDRESS of what it opens beside the command
    // that opens it (menuLink.ts), so a router stub without it is a stub of half a router.
    useRouter: () => ({ push: vi.fn(), replace, resolve: (to: string) => ({ href: to }) }) as never,
}));

/* THE TUNNEL AS THE DAEMON REPORTS IT: every dial parameter echoed, the WireGuard conf absent, and `secrets`
 * naming the key that is missing. That last field is the whole difference between an editable form and a
 * destructive one — without it the browser cannot tell "there is a key here I may not show you" from "there is
 * no key here", and both render as an empty required box. */
const capabilities = ref<CapabilitySummary[]>([]);
const office = (): CapabilitySummary => ({
    id: `office`,
    kind: `vpn`,
    status: { state: `active` },
    config: { provider: `wireguard`, autoConnect: `on` },
    secrets: [`config`],
});

const add = vi.fn<(input: AddCapabilityInput) => Promise<void>>(async () => {});
vi.mock(`../composables/extensions/useCapabilities`, () => ({
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
vi.mock(`../composables/extensions/useExtensions`, () => ({
    useExtensions: () => ({ contributionOf: () => undefined, enabled: ref([]), extensions: ref([]), settled: ref(true) }),
}));
vi.mock(`../composables/extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
vi.mock(`../composables/terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
vi.mock(`../composables/sandbox/useVpn`, () => ({ importForticlient: vi.fn(), useVpn: () => ({ links: ref([]) }) }));
vi.mock(`../components/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../components/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

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

// The card's own form, submitted the way the button submits it — the submit is a PrimeVue component and what
// it does is dispatch this.
const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    await nextTick();
};

const nameBox = (el: HTMLElement): HTMLInputElement | null =>
    [...el.querySelectorAll(`label`)].find((label) => label.textContent?.startsWith(`Name`))?.querySelector(`input`) ?? null;
const wireguardBox = (el: HTMLElement): HTMLTextAreaElement => el.querySelector(`textarea`)!;

it(`opens a live connection's own settings, and says whose they are`, () => {
    const el = start(`office`);

    // Filled from the connection, not from the card: the switch is where the user left it, not at its default.
    expect(el.textContent).toContain(`Editing`);
    expect(el.textContent).toContain(`office`);
    // No name box — renaming moves what the name keys (a browser profile, a machine's enrollment), so it is its
    // own migration and a second, lossy way to do it here would be a trap wearing a text box.
    expect(nameBox(el)).toBeNull();
    // The word on the button is the one thing a reader checks before pressing it over somebody's live gateway.
    expect(el.textContent).toContain(`Save changes`);

    // The credential is blank, because it was never sent — and the box says so where the eye already is,
    // instead of reading as one more thing to go and find.
    expect(wireguardBox(el).value).toBe(``);
    expect(wireguardBox(el).placeholder).toContain(`already set`);
    expect(wireguardBox(el).placeholder).toContain(`leave blank to keep`);
});

it(`saves over the same connection and keeps the credential it was never shown`, async () => {
    const el = start(`office`);

    await submitForm(el);

    // The same id — an edit, not a second tunnel — and the marker where the conf goes. An empty string would be
    // a config that fails to dial; a dropped key would fail the daemon's schema.
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: `office`, kind: `vpn` }));
    expect(add.mock.calls[0]?.[0].config).toEqual({ provider: `wireguard`, config: VAULTED, autoConnect: `on` });
});

it(`replaces the credential when one is actually typed`, async () => {
    const el = start(`office`);

    const box = wireguardBox(el);
    box.value = `[Interface]\nPrivateKey = NEW\n`;
    box.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
    // A value present is a value meant: the placeholder's promise only covers a box left alone.
    expect(box.placeholder).not.toContain(`already set`);

    await submitForm(el);
    expect(add.mock.calls[0]?.[0].config[`config`]).toBe(`[Interface]\nPrivateKey = NEW`);
});

/* WITHOUT THE QUERY THE CARD IS ADDING, which is what it always did — and the connection it already holds is
 * listed above the form rather than loaded into it. The name is pre-filled with a FREE one (the card's own id
 * here, since the live tunnel took a name of its own), so pressing the button makes a second tunnel instead of
 * writing the card's defaults over the first. */
it(`still adds a second connection when no connection is being edited`, async () => {
    const el = start(undefined);

    expect(el.textContent).toContain(`Add another`);
    expect(el.textContent).not.toContain(`Editing`);
    expect(nameBox(el)?.value).toBe(`vpn`);
    // Nothing is stored under the new name, so the credential is a question again rather than a promise.
    expect(wireguardBox(el).placeholder).not.toContain(`already set`);
});
