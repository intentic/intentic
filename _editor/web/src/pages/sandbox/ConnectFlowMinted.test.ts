// @vitest-environment jsdom
//
// A MINTED PROVIDER'S SIGN-IN, ON SCREEN, and what makes it worth its own file rather than a case in the panel's
// other tests: these two providers used to render a password field here, and the whole point of the change is
// that they now render the SAME two shapes every other sign-in does. So this asserts the shapes off the live
// handshake's own `flow` field, which is the only thing that decides them.
//
//   device   , read-only: a page to open, the code the vendor issued where there is one, and no field at all,
//              because there is nothing to bring back (Meta's, and Z.ai's international plan's);
//   redirect , the page dead-ends on a loopback address, so the panel draws the browser error the user is about
//              to meet and takes the address back (BigModel's).
//
// The two failures these cover are both ones that shipped in this app before, on other providers: a paste field
// rendered under a flow that finishes by itself (a person waits at it forever), and a redirect whose grant this
// panel does not recognise off the clipboard, which is the step people abandon on.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

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
vi.mock(`../../composables/chat/useChat`, () => ({
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
// Two design-system leaves the panel draws. Stubbed rather than imported so the assertions below are about the
// panel's own markup and not about how <Button> happens to render this week.
vi.mock(`@intentic/ui`, () => ({
    ui: { inputSm: (extra: string) => extra, textAction: (extra: string) => extra },
    // `as` and `href` are honoured because the panel's first control is a LINK to the provider, and where that
    // link points is one of the things worth asserting here.
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
vi.mock(`../../chat/ProviderLogo.vue`, () => ({ default: defineComponent({ render: () => h(`svg`) }) }));

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
    // `Icon` is registered globally by the app shell; the panel uses it and nothing here is about it.
    app.component(`Icon`, defineComponent({ render: () => h(`i`) }));
    app.mount(host);
    return host;
};

const paste = async (host: HTMLElement, text: string): Promise<void> => {
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`)!;
    field.value = text;
    field.dispatchEvent(new Event(`input`));
    // The watch that recognises the address, then the render it schedules.
    await Promise.resolve();
    await Promise.resolve();
};

/* A DEVICE SIGN-IN SHOWS THE CODE AND NOTHING TO FILL IN. The failure this pins is specific: an empty `code`
 * used to mean "paste-back", so a flow that finishes by itself and issues no code would render a field the user
 * would wait at forever. `flow` on the handshake is what tells them apart now. */
it(`a minted device sign-in shows the vendor's code and asks for nothing back`, async () => {
    const host = await mount({ provider: `meta`, url: `https://meta.example/device`, code: `WDJB-MJHT`, flow: `device`, handshake: `h1` });
    expect(host.textContent).toContain(`WDJB-MJHT`);
    expect(host.querySelector(`input[name="connectCode"]`), `a device sign-in offered a field to paste into`).toBeNull();
    // The page to open is the vendor's, not something derived here.
    expect(host.querySelector(`a`)?.getAttribute(`href`)).toBe(`https://meta.example/device`);
});

it(`a minted device sign-in with no code waits rather than showing an empty code box`, async () => {
    const host = await mount({ provider: `zai`, url: `https://z.ai/oauth`, code: ``, flow: `device`, handshake: `h2` });
    expect(host.textContent).toContain(`Waiting for approval`);
    expect(host.querySelector(`input[name="connectCode"]`)).toBeNull();
});

/* A REDIRECT SIGN-IN DRAWS THE DEAD END BEFORE THE USER MEETS IT. The page never loads — it points at a port
 * only this container binds — and every instinct says the sign-in broke, which is the step people abandon on. */
it(`a minted redirect warns the page won't load, and takes the address back`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    expect(host.textContent).toContain(`won't load`);
    const field = host.querySelector<HTMLInputElement>(`input[name="connectCode"]`);
    expect(field?.placeholder).toContain(`address`);
});

/* `authCode=` IS THE GRANT HERE, not `code=`, and that one word is the whole difference between an address that
 * finishes the sign-in by itself and one that sits in the field being ignored. BigModel names it the first way;
 * every other OAuth on earth names it the second, which is why reading only `code=` looked correct. */
it(`recognises BigModel's authCode= address on its own and finishes with it`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    const landed = `http://127.0.0.1:8317/?authCode=abc123&state=st-9`;
    await paste(host, landed);
    // The whole address, untouched: the daemon parses it, because the state check belongs where the attempt is
    // held rather than in a browser that would be checking a claim against itself.
    expect(completeConnect).toHaveBeenCalledWith(landed);
});

/* AN ADDRESS FROM A DIFFERENT ATTEMPT IS LEFT ALONE. A second tab, an old paste: auto-finishing on it would
 * send another sign-in's grant to this handshake, and the daemon would refuse it — after this panel had already
 * cleared the field and reported success. */
it(`leaves an address carrying another attempt's state sitting in the field`, async () => {
    const host = await mount({ provider: `zai`, url: `https://bigmodel.cn/login`, code: ``, state: `st-9`, flow: `redirect`, handshake: `h3` });
    await paste(host, `http://127.0.0.1:8317/?authCode=abc123&state=someone-elses`);
    expect(completeConnect).not.toHaveBeenCalled();
});
