// A Browsers tab's answer to its frame asking for a guarded preview's pass: the daemon's one-time link goes into the
// frame; an ask back within moments is explained, not answered again, with a tab of its own as the way on; a refusal is
// said in the daemon's words; and an ask from anywhere but the tab's own frame, or about any other origin, is ignored.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, nextTick } from "vue";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const PREVIEW = `https://preview-shop-0123456789ab.example.test`;
const LINK = `${PREVIEW}/__intentic/preview-pass?ticket=t1&to=%2Fcart`;

const previewPass = jest.fn(async (input: { url: string }) => ({ url: `${PREVIEW}/__intentic/preview-pass?ticket=t1&to=${encodeURIComponent(new URL(input.url).pathname)}` }));
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({ ports: { previewPass: (input: { url: string }) => previewPass(input) } }),
}));

const { usePreviewPass } = await import("./usePreviewPass");

// Any message source stands for the tab's own frame; a port is one.
const frame = new MessageChannel().port1;
const elsewhere = new MessageChannel().port1;

// What the code under test touches on the tab it opens.
interface OpenedTab {
    opener: unknown;
    location: { href: string };
    close: () => void;
}

let app: App | undefined;
let pass: ReturnType<typeof usePreviewPass> | undefined;
const mount = (): ReturnType<typeof usePreviewPass> => {
    const host = defineComponent({
        setup: () => {
            pass = usePreviewPass(
                () => frame,
                () => PREVIEW,
            );
            return () => null;
        },
    });
    app = createApp(host);
    app.mount(document.createElement(`div`));
    return pass!;
};

const ask = async (href: string, source: MessagePort = frame): Promise<void> => {
    window.dispatchEvent(new MessageEvent(`message`, { data: { intentic: `preview-pass`, href }, source }));
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

const windowOpen = globalThis.window.open;
afterEach(() => {
    globalThis.window.open = windowOpen;
    app?.unmount();
    app = undefined;
    previewPass.mockClear();
});

it(`answers the frame's ask with the daemon's one-time link, for the address the frame was on`, async () => {
    const { link, notice } = mount();
    await ask(`${PREVIEW}/cart`);

    expect(previewPass).toHaveBeenCalledWith({ url: `${PREVIEW}/cart` });
    expect(link.value).toBe(LINK);
    expect(notice.value).toBeUndefined();
});

it(`ignores an ask from another window, or about another origin`, async () => {
    const { link } = mount();
    await ask(`${PREVIEW}/cart`, elsewhere);
    await ask(`https://evil.test/cart`);

    expect(previewPass).not.toHaveBeenCalled();
    expect(link.value).toBeUndefined();
});

// The browser did not keep the pass (cookies blocked for the preview, or in frames): another would only come back too.
it(`explains an ask back moments after a pass instead of minting another, and offers the preview a tab of its own`, async () => {
    const { notice } = mount();
    await ask(`${PREVIEW}/cart`);
    await ask(`${PREVIEW}/cart`);

    expect(previewPass).toHaveBeenCalledTimes(1);
    expect(notice.value?.title).toBe(`Your browser didn't keep this preview's sign-in.`);
    expect(notice.value?.detail).toBe(`Allow cookies for preview-shop-0123456789ab.example.test, or open the preview in a tab of its own.`);
    expect(notice.value?.action?.label).toBe(`Open in a new tab`);

    // The tab is opened on the press, before the daemon answers, then cut from this window and sent through a pass of its own.
    const opened: OpenedTab = { opener: window, location: { href: `` }, close: () => undefined };
    // SAFETY: the code under test touches only `opener`, `location.href` and `close` on the window it opens.
    const open = jest.fn((): Window | null => opened as Window);
    globalThis.window.open = open;
    notice.value?.action?.run();
    expect(open).toHaveBeenCalledWith(``, `_blank`);
    await waitFor(() => expect(opened.location.href).toBe(LINK));
    expect(opened.opener).toBeNull();
    expect(previewPass).toHaveBeenCalledTimes(2);
});

it(`says a refusal in the daemon's words, and loads nothing`, async () => {
    previewPass.mockImplementationOnce(async () => {
        throw new SandboxHttpError(403, `Guests can't open this sandbox's previews.`);
    });
    const { link, notice } = mount();
    await ask(`${PREVIEW}/cart`);

    expect(link.value).toBeUndefined();
    expect(notice.value?.title).toBe(`Couldn't sign you in to this preview.`);
    expect(notice.value?.detail).toBe(`Guests can't open this sandbox's previews.`);
});

it(`follows no answer that leads off the preview's origin`, async () => {
    previewPass.mockImplementationOnce(async () => ({ url: `https://evil.test/` }));
    const { link, notice } = mount();
    await ask(`${PREVIEW}/cart`);

    expect(link.value).toBeUndefined();
    expect(notice.value?.title).toBe(`Couldn't sign you in to this preview.`);
});

// A reload or a navigation while the daemon is asked: the answer is about a page the frame has left.
it(`drops an answer that arrives after the frame moved on, and a spent link with the move`, async () => {
    let answer: (value: { url: string }) => void = () => undefined;
    previewPass.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { link, settle } = mount();
    await ask(`${PREVIEW}/cart`);
    settle();
    answer({ url: LINK });
    await nextTick();
    expect(link.value).toBeUndefined();

    await ask(`${PREVIEW}/cart`);
    expect(link.value).toBe(LINK);
    settle();
    expect(link.value).toBeUndefined();
});
