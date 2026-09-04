// @vitest-environment jsdom
//
// THE THIRD CONNECT MECHANISM, ON SCREEN. ConnectFlow serves all three — a native handshake, a translator
// subscription login, and a key you already hold — and the first two only ever render under a live handshake.
// The keyed one has none, which is exactly the property worth pinning: if it inherited the `v-if="flow"` the
// others sit behind, the row would be a heading with nothing under it, and nothing anywhere would fail.
//
// So this mounts the panel for every keyed provider the contract has and asserts the three things a person
// needs from it: somewhere to put the key, somewhere to GET one, and a Connect that actually hands it over.
import { KEY_PROVIDERS, keyEndpointOf, providerSpec } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

const connectKey = vi.fn(async () => true);

// The chat store is a module singleton the panel reads directly; this is the whole of what it needs from it.
vi.mock(`../../composables/chat/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow: ref(undefined),
        translatorConnectFlow: ref(undefined),
        accountBusy: ref(undefined),
        translatorKey: (provider: string) => `translator:${provider}`,
        connectLabel: ref(``),
        completeConnect: vi.fn(),
        completeTranslator: vi.fn(),
        connectKey,
    }),
}));
// Two design-system leaves the panel draws. Stubbed rather than imported so the assertions below are about the
// panel's own markup and not about how <Button> happens to render this week.
vi.mock(`@intentic/ui`, () => ({
    ui: { inputSm: (extra: string) => extra, textAction: (extra: string) => extra },
    Button: defineComponent({
        props: { label: String, disabled: Boolean, loading: Boolean },
        emits: [`click`],
        setup:
            (props, { emit }) =>
            () =>
                h(`button`, { disabled: props.disabled, onClick: () => emit(`click`) }, props.label),
    }),
    CopyButton: defineComponent({ render: () => h(`button`) }),
}));
vi.mock(`../../chat/ProviderLogo.vue`, () => ({ default: defineComponent({ render: () => h(`svg`) }) }));

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    connectKey.mockClear();
});

const mount = async (provider: string): Promise<HTMLElement> => {
    const { default: ConnectFlow } = await import(`./ConnectFlow.vue`);
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(defineComponent({ render: () => h(ConnectFlow, { kind: `keyed`, provider }) }));
    // `Icon` is registered globally by the app shell; the panel uses it and nothing here is about it.
    app.component(`Icon`, defineComponent({ render: () => h(`i`) }));
    app.mount(host);
    return host;
};

it.each(KEY_PROVIDERS)(`%s's panel opens on a key field rather than on a button that reveals one`, async (provider) => {
    const host = await mount(provider);
    const field = host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`);
    expect(field?.type, `${provider} shows the key as it is typed`).toBe(`password`);
    // The placeholder names the vendor, so a person with two keys open knows which field they are in.
    expect(field?.placeholder).toContain(providerSpec(provider)?.destination);
});

it.each(KEY_PROVIDERS)(`%s links to the console that issues its key`, async (provider) => {
    const host = await mount(provider);
    const link = [...host.querySelectorAll(`a`)].find((anchor) => anchor.textContent?.includes(`Get a key`));
    // "Paste your API key" is only actionable if you know which of a vendor's several consoles mints it, so
    // this URL is the provider's own spec row rather than a guess.
    expect(link?.getAttribute(`href`)).toBe(keyEndpointOf(provider)?.console);
});

it.each(KEY_PROVIDERS)(`%s's Connect stays inert until there is a key, then hands it over`, async (provider) => {
    const host = await mount(provider);
    const button = [...host.querySelectorAll(`button`)].find((element) => element.textContent === `Connect`);
    expect(button?.disabled, `${provider} offers a Connect with nothing to connect`).toBe(true);

    const field = host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`)!;
    field.value = `  vendor-key  `;
    field.dispatchEvent(new Event(`input`));
    await Promise.resolve();

    [...host.querySelectorAll(`button`)].find((element) => element.textContent === `Connect`)?.click();
    await Promise.resolve();
    // The raw field value, trimmed at the store rather than here: what matters is that the panel does not
    // transform it, because a key with a character silently removed fails as an unexplainable 401.
    expect(connectKey).toHaveBeenCalledWith(provider, `  vendor-key  `, ``);
});
