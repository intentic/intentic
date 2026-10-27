// `/preview-pass?url=`, where a guarded preview's "Continue to Intentic" lands: which sandbox it asks for a pass, and
// each way it stops short of sending the browser on (an address that is no preview's, a sandbox this account does not
// list, a refusal, a browser back too soon to have kept the last pass), said in place with a way on.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const SANDBOX = `0123456789ab`;
const PREVIEW = `https://preview-shop-${SANDBOX}.example.test/cart`;

const previewPass = jest.fn(async (_input: { url: string }, _options?: unknown) => ({ url: `https://preview-shop-${SANDBOX}.example.test/__intentic/preview-pass?ticket=t1&to=%2Fcart` }));
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({ ports: { previewPass: (input: { url: string }, options?: unknown) => previewPass(input, options) } }),
}));
const list = jest.fn(async (): Promise<readonly { id: string }[]> => [{ id: SANDBOX }]);
jest.mock(`../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ list: () => list() }) }));

const { default: PreviewPass } = await import("./PreviewPass.vue");
const { rememberPass } = await import("./previewPassRules");

let app: App | undefined;
const mount = async (url?: string): Promise<void> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/preview-pass`, component: PreviewPass },
            { path: `/:rest(.*)*`, component: { render: () => null } },
        ],
    });
    await router.push(url === undefined ? `/preview-pass` : { path: `/preview-pass`, query: { url } });
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(RouterView) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.use(router);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};
const shown = (): string => document.body.textContent ?? ``;
const buttonLabelled = (label: string): HTMLElement | undefined =>
    [...document.body.querySelectorAll<HTMLElement>(`button, a`)].find((button) => button.textContent?.trim() === label);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sessionStorage.clear();
    previewPass.mockClear();
    list.mockClear();
});

it(`asks the preview's own sandbox for a pass to the address, and remembers having sent the browser through it`, async () => {
    await mount(PREVIEW);

    await waitFor(() => expect(previewPass).toHaveBeenCalledWith({ url: PREVIEW }, { context: { at: SANDBOX } }));
    expect(sessionStorage.getItem(`intentic.previewPass`)).toContain(`preview-shop-${SANDBOX}.example.test`);
});

it(`asks nothing for an address that is no preview's, and leads Home`, async () => {
    await mount(`https://example.test/`);

    expect(shown()).toContain(`This link doesn't name a preview's address.`);
    expect(buttonLabelled(`Go to Home`)).not.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(previewPass).not.toHaveBeenCalled();
});

it(`says a sandbox this account does not list is not its to open, and asks it nothing`, async () => {
    list.mockImplementationOnce(async () => [{ id: `ffffffffffff` }]);
    await mount(PREVIEW);

    expect(shown()).toContain(`This preview belongs to a sandbox your account can't open: ask its owner to invite you.`);
    expect(previewPass).not.toHaveBeenCalled();
});

it(`says a refusal in the daemon's words, with the way into the sandbox and another try`, async () => {
    previewPass.mockImplementationOnce(async () => {
        throw new SandboxHttpError(403, `Guests can't open this sandbox's previews.`);
    });
    await mount(PREVIEW);

    await waitFor(() => expect(shown()).toContain(`Couldn't open the preview.`));
    expect(shown()).toContain(`Guests can't open this sandbox's previews.`);
    expect(buttonLabelled(`Open the sandbox`)).not.toBeUndefined();
    expect(buttonLabelled(`Try again`)).not.toBeUndefined();
});

// The browser is back moments after a pass to this preview: it did not keep it, and another would only come back too.
it(`explains a return too soon after a pass instead of minting another, until the person asks again`, async () => {
    rememberPass(`preview-shop-${SANDBOX}.example.test`, Date.now());
    await mount(PREVIEW);

    expect(shown()).toContain(`Your browser didn't keep this preview's sign-in.`);
    expect(shown()).toContain(`Allow cookies for preview-shop-${SANDBOX}.example.test, then try again.`);
    expect(previewPass).not.toHaveBeenCalled();

    buttonLabelled(`Try again`)?.click();
    await waitFor(() => expect(previewPass).toHaveBeenCalledTimes(1));
});
