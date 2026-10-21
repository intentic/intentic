import type { IntenticApi } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { OpenResult } from "./contract.js";
import { CHANNEL, type PageMessage } from "./protocol.js";
import { bindHost } from "./host.js";
import { WAIT_MS } from "./slot.js";

// The real viewer and EditorSlot, with only the host's backend and the UI kit stood in. An open is asserted at the
// backend boundary, and the document's surrounding chrome is asserted in the DOM, not through a mode helper.
const control = defineComponent({
    setup:
        (_, { attrs, slots }) =>
        () =>
            h(`button`, attrs, slots[`default`]?.()),
});
const hidden = defineComponent({ setup: () => () => null });
jest.mock("@intentic/extension-ui", () => ({
    activeLocale: ref(`en`),
    appLink: (href: string) => ({ href }),
    Button: control,
    Checkbox: hidden,
    ConfirmDialog: hidden,
    formatDateTime: String,
    Icon: hidden,
    Notice: hidden,
    ProgressRing: hidden,
    ui: { textButton: (classes: string) => classes },
}));
jest.mock("./i18n.js", () => ({ t: (key: string) => key }));
const { default: OnlyOfficeViewer } = await import("./OnlyOfficeViewer.vue");

const settings = new Map<string, ReturnType<IntenticApi[`settings`][`get`]>>();
const asked: { path: string; body: unknown }[] = [];
let role: ReturnType<IntenticApi[`sandbox`][`role`]>;
let result: OpenResult;
let kept = false;
let app: App | undefined;
let hostChanged = (_key: string): void => undefined;

beforeEach(() => {
    settings.clear();
    settings.set(`engine`, `browser`);
    asked.length = 0;
    role = `owner`;
    kept = false;
    result = { url: `https://office.example/editor?s=one`, session: `one`, engine: `browser` };
    bindHost(
        unstubbed<IntenticApi>(`host`, {
            settings: unstubbed<IntenticApi[`settings`]>(`host.settings`, {
                get: (key) => settings.get(key),
                onDidChange: (listener) => {
                    hostChanged = listener;
                    return { dispose: () => undefined };
                },
            }),
            sandbox: unstubbed<IntenticApi[`sandbox`]>(`host.sandbox`, {
                role: () => role,
                previewAddress: async (url) => url,
            }),
            backend: unstubbed<IntenticApi[`backend`]>(`host.backend`, {
                request: async (path, init) => {
                    asked.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
                    const body = path === `open` ? result : { kept };
                    return new Response(JSON.stringify(`status` in body ? body.status : body), { status: `status` in body ? 409 : 200 });
                },
            }),
            href: (path) => path,
            navigate: () => undefined,
        }),
    );
});

const waits = { ...WAIT_MS };

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    Object.assign(WAIT_MS, waits);
});

const mount = (props: { path: string; agent?: string; readOnly?: boolean } = { path: `brief.docx` }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp(OnlyOfficeViewer, props);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};
const framed = (element: HTMLElement): Promise<void> =>
    waitFor(async () => {
        expect(element.querySelectorAll(`iframe`)).toHaveLength(1);
        await nextTick();
    });
const opens = () => asked.filter((request) => request.path === `open`).map((request) => request.body);
// What the editor page in the viewer's frame says, from its own window and origin.
const pageSays = (element: HTMLElement, message: PageMessage): void => {
    window.dispatchEvent(
        new MessageEvent(`message`, { data: message, origin: `https://office.example`, source: element.querySelector(`iframe`)?.contentWindow ?? null }),
    );
};
// The wait laid over the frame, or in its place: the one element that says what the reader is waiting for.
const wait = (element: HTMLElement): Element | null => element.querySelector(`[role="status"]`);
const opening = { path: `brief.docx`, mode: `edit`, theme: `light`, engine: `browser`, lang: `en`, origin: window.location.origin };

it(`opens a writable local DOCX directly for editing with no mode control or header row`, async () => {
    settings.set(`localWindow`, true);
    const element = mount();
    await framed(element);
    expect(opens()).toEqual([opening]);
    pageSays(element, { channel: CHANNEL, type: `ready` });
    await waitFor(() => expect(wait(element)).toBeNull());
    expect(element.querySelectorAll(`button`)).toHaveLength(0);
    // The only child is the editor's place: no reserved row above it, even an empty one, and nothing over the frame.
    expect(element.firstElementChild?.children).toHaveLength(1);
    expect(element.firstElementChild?.firstElementChild?.children).toHaveLength(1);
    expect(element.firstElementChild?.firstElementChild?.firstElementChild?.firstElementChild?.tagName).toBe(`IFRAME`);
});

describe(`while the editor loads`, () => {
    const mountWithText = (): HTMLElement => {
        const element = document.createElement(`div`);
        document.body.append(element);
        app = createApp({ setup: () => () => h(OnlyOfficeViewer, { path: `brief.docx` }, { text: () => h(`p`, { class: `text` }, `the document's text`) }) });
        app.directive(`tooltip`, {});
        app.mount(element);
        return element;
    };

    it(`covers the framed editor until its page says the document is open`, async () => {
        WAIT_MS.text = 60_000;
        const element = mountWithText();
        await framed(element);
        // In the slot and laid out at its size, but hidden from the reader behind the wait.
        expect(wait(element)?.textContent).toContain(`onlyOfficeViewer.openingInOnlyoffice`);
        expect(element.querySelector(`iframe`)?.parentElement?.getAttribute(`aria-hidden`)).toBe(`true`);
        pageSays(element, { channel: CHANNEL, type: `loading` });
        await nextTick();
        expect(wait(element)).not.toBeNull();
        pageSays(element, { channel: CHANNEL, type: `ready` });
        await waitFor(() => expect(wait(element)).toBeNull());
        expect(element.querySelector(`iframe`)?.parentElement?.hasAttribute(`aria-hidden`)).toBe(false);
        expect(element.querySelector(`.text`)).toBeNull();
    });

    it(`shows the document's text once the wait is more than a moment`, async () => {
        WAIT_MS.text = 10;
        const element = mountWithText();
        await framed(element);
        await waitFor(() => expect(element.querySelector(`.text`)?.textContent).toBe(`the document's text`));
        expect(wait(element)?.textContent).toContain(`onlyOfficeViewer.textUntilEditor`);
        pageSays(element, { channel: CHANNEL, type: `ready` });
        await waitFor(() => expect(element.querySelector(`.text`)).toBeNull());
    });

    it(`offers a fresh start once the wait is long, and starts one`, async () => {
        WAIT_MS.text = 60_000;
        WAIT_MS.slow = 10;
        const element = mount();
        await framed(element);
        const first = element.querySelector(`iframe`);
        await waitFor(() => expect(wait(element)?.textContent).toContain(`onlyOfficeViewer.slowToOpen`));
        const retry = [...element.querySelectorAll(`button`)].find((button) => button.textContent === `onlyOfficeViewer.tryAgain`);
        WAIT_MS.slow = 60_000;
        retry?.click();
        await waitFor(() => expect(opens()).toHaveLength(2));
        await framed(element);
        expect(element.querySelector(`iframe`)).not.toBe(first);
        expect(first?.isConnected).toBe(false);
        expect(wait(element)?.textContent).not.toContain(`onlyOfficeViewer.slowToOpen`);
    });

    it(`says the document could not be opened, in place of the editor that failed, with a fresh start`, async () => {
        WAIT_MS.text = 60_000;
        const element = mount();
        await framed(element);
        pageSays(element, { channel: CHANNEL, type: `open-failed`, detail: `Conversion failed with code 89` });
        await waitFor(() => expect(wait(element)?.textContent).toContain(`onlyOfficeViewer.couldNotOpen`));
        expect(wait(element)?.textContent).toContain(`Conversion failed with code 89`);
        [...element.querySelectorAll(`button`)].find((button) => button.textContent === `onlyOfficeViewer.tryAgain`)?.click();
        await waitFor(() => expect(opens()).toHaveLength(2));
        await waitFor(() => expect(wait(element)?.textContent).not.toContain(`onlyOfficeViewer.couldNotOpen`));
    });
});

it(`opens a writable sandbox DOCX directly for editing too`, async () => {
    role = `maintainer`;
    await framed(mount());
    expect(opens()).toEqual([opening]);
});

it.each([`writer`, `collaborator`, `viewer`, `guest`] as const)(`keeps a %s's DOCX read-only without offering a mode switch`, async (tier) => {
    role = tier;
    const element = mount();
    await framed(element);
    expect(opens()).toEqual([{ ...opening, mode: `view` }]);
    expect(element.querySelectorAll(`button`)).toHaveLength(0);
});

it(`keeps the host's protected file read-only`, async () => {
    await framed(mount({ path: `brief.docx`, readOnly: true }));
    expect(opens()).toEqual([{ ...opening, mode: `view` }]);
});

it(`keeps an agent's checkout read-only`, async () => {
    await framed(mount({ path: `brief.docx`, agent: `agent-one` }));
    expect(opens()).toEqual([{ ...opening, mode: `view`, agent: `agent-one` }]);
});

it(`reopens the next document directly for editing, with no remembered choice`, async () => {
    const props = ref({ path: `brief.docx`, readOnly: false });
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ setup: () => () => h(OnlyOfficeViewer, props.value) });
    app.directive(`tooltip`, {});
    app.mount(element);
    await framed(element);
    props.value = { path: `next.docx`, readOnly: false };
    await waitFor(() => expect(opens()).toHaveLength(2));
    await framed(element);
    expect(opens()).toEqual([opening, { ...opening, path: `next.docx` }]);
    props.value = { path: `next.docx`, readOnly: true };
    await waitFor(() => expect(opens()).toHaveLength(3));
    expect(opens()).toEqual([opening, { ...opening, path: `next.docx` }, { ...opening, path: `next.docx`, mode: `view` }]);
});

it(`offers original recovery only after a save actually kept an original`, async () => {
    const element = mount();
    await framed(element);
    pageSays(element, { channel: CHANNEL, type: `ready` });
    kept = true;
    const frame = element.querySelector(`iframe`);
    window.dispatchEvent(
        new MessageEvent(`message`, {
            data: { channel: CHANNEL, type: `saved`, path: `brief.docx` },
            origin: `https://office.example`,
            source: frame?.contentWindow,
        }),
    );
    await waitFor(() => expect(element.textContent).toContain(`onlyOfficeViewer.originalKept`));
    expect([...element.querySelectorAll(`button`)].map((button) => button.textContent)).toEqual([`onlyOfficeViewer.restoreOriginal`]);
    expect(asked.map((request) => request.path)).toEqual([`open`, `original?path=brief.docx`]);
});

it(`does not restart the editor for a retired reading-first preference`, async () => {
    const element = mount();
    await framed(element);
    settings.set(`openAs`, `view`);
    hostChanged(`openAs`);
    await nextTick();
    expect(opens()).toEqual([opening]);
});

it.each([true, false])(`offers sandbox settings only outside a local window (local: %s)`, async (local) => {
    settings.set(`localWindow`, local);
    result = { status: { state: `not-started` } };
    const element = mount();
    await waitFor(() => expect(element.textContent).toContain(`onlyOfficeViewer.openEditSaveInBrowser`));
    expect([...element.querySelectorAll(`a`)].map((link) => link.textContent)).toEqual(local ? [] : [`onlyOfficeViewer.extensionSettings`]);
});
