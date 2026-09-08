// @vitest-environment jsdom
// Pins that minted providers (meta, zai) render the same device/redirect shapes as every sign-in, asserted off
// the handshake's own `flow` field. Covers two regressions: a paste field left under a self-finishing flow, and a
// redirect grant not recognized off the clipboard.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

interface Flow {
    provider: string;
    url: string;
    code: string;
    state?: string;
    flow?: `device` | `redirect`;
    handshake?: string;
}

const nativeConnectFlow = ref<Flow | undefined>(undefined);
const completeConnect = vi.fn(async () => true);

// The chat store is a module singleton the panel reads directly; this is the whole of what it needs from it.
vi.mock(`../../chat/run/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow,
        translatorConnectFlow: ref(undefined),
        accountBusy: ref(undefined),
        translatorKey: (provider: string) => `translator:${provider}`,
        connectLabel: ref(``),
        completeConnect,
        completeTranslator: vi.fn(),
    }),
}));
// Stubbed, not imported, so assertions test the panel's own markup, not <Button>'s current rendering.
vi.mock(`@intentic/ui`, () => ({
    ui: { inputSm: (extra: string) => extra, textAction: (extra: string) => extra },
    // `as`/`href` honoured since the panel's first control is a link to the provider, and its target is asserted here.
    Button: defineComponent({
        props: { label: String, disabled: Boolean, loading: Boolean, as: String, href: String },
        emits: [`click`],
        setup:
            (props, { emit, slots }) =>
            () =>
                h(props.as === `a` ? `a` : `button`, { disabled: props.disabled, href: props.href, onClick: () => emit(`click`) }, [
                    props.label,
                    slots["default"]?.(),
                ]),
    }),
    CopyButton: defineComponent({ render: () => h(`button`) }),
}));
vi.mock(`../../chat/accounts/ProviderLogo.vue`, () => ({ default: defineComponent({ render: () => h(`svg`) }) }));

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    nativeConnectFlow.value = undefined;
    completeConnect.mockClear();
});

const mount = async (flow: Flow): Promise<HTMLElement> => {
    nativeConnectFlow.value = flow;
    const { default: ConnectFlow } = await import(`./ConnectFlow.vue`);
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(defineComponent({ render: () => h(ConnectFlow, { kind: `native`, provider: flow.provider }) }));
    // Icon is registered globally by the app shell; not under test here.
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

const paste = async (host: HTMLElement, text: string): Promise<void> => {
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`)!;
    field.value = text;
    field.dispatchEvent(new Event(`input`));
    // Awaits the watch that recognises the address, then the render it schedules.
    await Promise.resolve();
    await Promise.resolve();
};

it(`a minted device sign-in shows the vendor's code and asks for nothing back`, async () => {
    const host = await mount({ provider: `meta`, url: `https://meta.example/device`, code: `WDJB-MJHT`, flow: `device`, handshake: `h1` });
    expect(host.textContent).toContain(`WDJB-MJHT`);
    expect(host.querySelector(`input[name="connectCode"]`), `a device sign-in offered a field to paste into`).toBeNull();
    expect(host.querySelector(`a`)?.getAttribute(`href`)).toBe(`https://meta.example/device`);
});

it(`a minted device sign-in with no code waits rather than showing an empty code box`, async () => {
    const host = await mount({ provider: `zai`, url: `https://z.ai/oauth`, code: ``, flow: `device`, handshake: `h2` });
    expect(host.textContent).toContain(`Waiting for approval`);
    expect(host.querySelector(`input[name="connectCode"]`)).toBeNull();
});

it(`a minted redirect warns the page won't load, and takes the address back`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    expect(host.textContent).toContain(`won't load`);
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`);
    expect(field?.placeholder).toContain(`address`);
});

it(`recognises BigModel's authCode= address on its own and finishes with it`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    const landed = `http://127.0.0.1:8317/?authCode=abc123&state=st-9`;
    await paste(host, landed);
    // Passed whole; the daemon does the state check, not this panel.
    expect(completeConnect).toHaveBeenCalledWith(landed);
});

it(`leaves an address carrying another attempt's state sitting in the field`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    await paste(host, `http://127.0.0.1:8317/?authCode=abc123&state=someone-elses`);
    expect(completeConnect).not.toHaveBeenCalled();
});
