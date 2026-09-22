// What the sign-in panel shows at each point of a handshake, asserted off the handshake's own `flow` field rather
// than the provider's name. Covers three regressions: a paste field left under a self-finishing flow, a redirect
// grant not recognized off the clipboard, and a panel still asking for an address while redeeming the one it has.
import "@intentic/testing/dom";
import { it, expect, afterEach, mock } from "bun:test";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

interface Flow {
    provider: string;
    url: string;
    code: string;
    state?: string;
    flow?: `device` | `redirect`;
    handshake?: string;
    redeemed?: boolean;
}

const nativeConnectFlow = ref<Flow | undefined>(undefined);
const translatorConnectFlow = ref<Flow | undefined>(undefined);
const connectSent = ref(false);
const completeConnect = mock(async () => true);
const completeTranslator = mock(async () => true);

// The chat store is a module singleton the panel reads directly; this is the whole of what it needs from it.
mock.module(`../../chat/run/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow,
        translatorConnectFlow,
        connectSent,
        accountBusy: ref(undefined),
        connectLabel: ref(``),
        completeConnect,
        completeTranslator,
    }),
}));
// Stubbed, not imported, so assertions test the panel's own markup, not <Button>'s current rendering.
mock.module(`@intentic/ui`, () => ({
    ui: { inputSm: (extra: string) => extra, textAction: (extra: string) => extra, linkButton: (extra: string) => extra },
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
mock.module(`../../chat/accounts/ProviderLogo.vue`, () => ({ default: defineComponent({ render: () => h(`svg`) }) }));

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    nativeConnectFlow.value = undefined;
    translatorConnectFlow.value = undefined;
    connectSent.value = false;
    completeConnect.mockClear();
    completeTranslator.mockClear();
});

const mount = async (flow: Flow, kind: `native` | `routed` = `native`): Promise<HTMLElement> => {
    (kind === `native` ? nativeConnectFlow : translatorConnectFlow).value = flow;
    const { default: ConnectFlow } = await import(`./ConnectFlow.vue`);
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(defineComponent({ render: () => h(ConnectFlow, { kind, provider: flow.provider }) }));
    // Icon is registered globally by the app shell; not under test here.
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

// The trip to the provider, which is what moves the panel from asking them to go to asking for the grant. A paste
// flow has no field until this has happened, so every paste test goes through here rather than reaching for one.
const goToProvider = async (): Promise<void> => {
    connectSent.value = true;
    await nextTick();
};

const paste = async (host: HTMLElement, text: string): Promise<void> => {
    await goToProvider();
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`)!;
    field.value = text;
    field.dispatchEvent(new Event(`input`));
    // Awaits the watch that recognises the address, then the render it schedules.
    await nextTick();
    await nextTick();
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

// The dead-end page is warned about BEFORE the trip and asked about after it: read the other way round, the
// warning arrives once the reader is two tabs away and has already met the failure.
it(`a minted redirect warns the page won't load before sending anyone to it`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    expect(host.textContent).toContain(`won't load`);
    expect(host.querySelector(`input[name="connectCode"]`), `asked for an address before sending anyone to fetch one`).toBeNull();
});

it(`a minted redirect takes the address back once the trip has been made`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    await goToProvider();
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`);
    expect(field?.placeholder).toContain(`address`);
});

// The panel that shipped drew the dead-end page at full size next to an 11px button, wearing the emphasis ring
// the app uses for focus: in the recorded session the reader pressed the picture, which is inert, and got nothing.
// Both halves are asserted, since either alone brings the decoy back.
it(`keeps the dead-end page off the step where the only action is leaving`, async () => {
    const host = await mount({ ...GOOGLE_FLOW }, `routed`);
    expect(host.textContent, `drew the page to copy from before there was anything to copy`).not.toContain(`This site can't be reached`);
    // Exactly one place to press: going. A second control here is what the picture used to be mistaken for.
    expect(host.querySelectorAll(`a`)).toHaveLength(1);
});

it(`shows the dead-end page only when asked, and never as something to press`, async () => {
    const host = await mount({ ...GOOGLE_FLOW }, `routed`);
    await goToProvider();
    expect(host.textContent).not.toContain(`This site can't be reached`);

    const disclosure = [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`What that page looks like`))!;
    disclosure.click();
    await nextTick();

    const picture = host.querySelector(`[aria-hidden="true"]`)!;
    expect(picture.textContent).toContain(`This site can't be reached`);
    expect(picture.className, `a picture that swallows presses reads as a control`).toContain(`pointer-events-none`);
});

// Someone who already made the trip — a reopened panel, a second tab — would otherwise have only Cancel.
it(`lets a reader who already holds the address reach the field without another trip`, async () => {
    const host = await mount({ ...GOOGLE_FLOW }, `routed`);
    const already = [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Already have it`))!;
    already.click();
    await nextTick();
    expect(host.querySelector(`input[name="connectCode"]`)).not.toBeNull();
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

// Google's is the sign-in this was reported on: the address arrives by itself off the clipboard, so the panel
// going quiet is the only thing that tells the user their paste was taken.
const GOOGLE_FLOW = { provider: `gemini`, url: `https://accounts.google.com/o/oauth2/v2/auth`, code: ``, state: `st-g`, flow: `redirect` } as const;
const GOOGLE_ADDRESS = `http://localhost:8317/?code=4/0AX4&state=st-g`;

it(`says the address is being redeemed, and offers nothing to redo while it is`, async () => {
    let land: ((connected: boolean) => void) | undefined;
    completeTranslator.mockImplementationOnce(() => new Promise<boolean>((resolve) => (land = resolve)));
    const host = await mount({ ...GOOGLE_FLOW }, `routed`);

    await paste(host, GOOGLE_ADDRESS);

    // Named after the provider spec's own `destination`, the same word the panel's open button uses.
    expect(host.textContent).toContain(`Finishing sign-in with Google`);
    expect(host.querySelector(`input[name="connectCode"]`), `asked for an address it was already redeeming`).toBeNull();
    expect(host.querySelector(`a`), `offered another trip to the provider mid-exchange`).toBeNull();

    land!(true);
    await nextTick();
    await nextTick();
    // The panel's own teardown is the store clearing the flow; here it stays mounted, and the field comes back empty.
    expect(host.querySelector<HTMLInputElement>(`input[name="connectCode"]`)?.value).toBe(``);
});

// A native redirect's account is minted after the grant is accepted and lands through the poll, so the panel
// outlives the paste: without this it went back to asking for the address it had just taken.
it(`waits out a redeemed grant rather than asking for the address a second time`, async () => {
    const host = await mount({
        provider: `zai`,
        url: `https://bigmodel.cn/login`,
        code: ``,
        state: `st-9`,
        flow: `redirect`,
        handshake: `h4`,
        redeemed: true,
    });
    expect(host.querySelector(`input[name="connectCode"]`), `asked again for an address it had already redeemed`).toBeNull();
    expect(host.textContent).toContain(`Finishing sign-in with Z.ai`);
});

it(`keeps a refused address in the field, so the retry is a second press`, async () => {
    completeTranslator.mockImplementationOnce(async () => false);
    const host = await mount({ ...GOOGLE_FLOW }, `routed`);

    await paste(host, GOOGLE_ADDRESS);

    expect(completeTranslator).toHaveBeenCalledWith(GOOGLE_ADDRESS);
    expect(host.querySelector<HTMLInputElement>(`input[name="connectCode"]`)?.value).toBe(GOOGLE_ADDRESS);
});
