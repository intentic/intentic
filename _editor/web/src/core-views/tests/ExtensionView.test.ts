// One wait from the host's first question to the view's first frame. Before the extension has registered, then while
// its view's chunk arrives, the host draws a placeholder (the page as it last looked, or an outline before it has been
// seen), past the reveal delay a route's chunk waits behind, and as ONE element: two waits back to back would each
// restart that delay and blink to nothing in between. A chunk that fails is the error boundary's to say.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { Activation, ViewRegistration } from "@intentic/extension-api";
import { type App, type Component, createApp, defineComponent, h, nextTick, reactive } from "vue";

jest.mock(`../../app/clientDiagnostics`, () => ({
    describeError: (error: unknown) => ({ message: String(error), fields: {} }),
    reportClient: () => undefined,
}));

const { default: ExtensionView } = await import("../ExtensionView.vue");

const mounted: { app: App; el: HTMLElement }[] = [];
beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    for (const { app, el } of mounted.splice(0)) {
        app.unmount();
        el.remove();
    }
    jest.useRealTimers();
});

interface Shown {
    extension?: ViewRegistration | undefined;
    activation?: Activation | undefined;
    waiting: boolean;
}

// `props` is what a test changes, the way a host's detection would.
const mountView = (shown: Shown) => {
    const props = reactive<Shown>(shown);
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(ExtensionView, { ...props, imprint: `ext:demo/demo` }) });
    app.mount(el);
    mounted.push({ app, el });
    return { el, props };
};

const registration = (view: () => Promise<Component>): ViewRegistration => ({
    id: `demo`,
    label: `Demo`,
    surface: `rail`,
    detect: () => [],
    view,
});
const activation: Activation = { key: `demo`, title: `Demo` };
const landed = defineComponent({ render: () => h(`section`, { "data-view": `` }, `the view`) });

// The loader's promise chain and Vue's render flush ride the same microtask queue; this drains both without timers.
const settle = async (): Promise<void> => {
    for (let beat = 0; beat < 8; beat += 1) {
        await nextTick();
    }
};

const waitShown = (el: HTMLElement): Element | null => el.querySelector(`[aria-busy="true"]`);

it(`draws one wait past the reveal delay, through the activation turning up, until the view lands in its place`, async () => {
    let land!: (view: Component) => void;
    const { el, props } = mountView({ waiting: true });

    // A wait under the reveal delay paints nothing: a view a moment away must not flash grey.
    await advanceTimersByTimeAsync(100);
    expect(waitShown(el)).toBeNull();
    await advanceTimersByTimeAsync(150);
    const wait = waitShown(el);
    expect(wait).not.toBeNull();

    // The extension registers; its chunk is still on the way. Same wait, not a second one starting over.
    Object.assign(props, { extension: registration(() => new Promise((resolve) => (land = resolve))), activation });
    await settle();
    expect(waitShown(el)).toBe(wait);

    land(landed);
    await settle();
    expect(waitShown(el)).toBeNull();
    // Inside a `contents` element: one thing to imprint, laid out as if nothing wrapped it.
    expect(el.querySelector(`.contents > [data-view]`)).not.toBeNull();
});

it(`leaves a failed chunk to the boundary's card, never a wait that runs on`, async () => {
    const { el } = mountView({ extension: registration(() => Promise.reject(new Error(`bundle gone`))), activation, waiting: false });
    await advanceTimersByTimeAsync(250);
    await settle();

    expect(waitShown(el)).toBeNull();
    expect(el.querySelector(`[data-view]`)).toBeNull();
    expect(el.textContent).toContain(`bundle gone`);
});

it(`draws a view whose chunk already landed at once, with no wait at all`, async () => {
    const once = registration(() => Promise.resolve(landed));
    mountView({ extension: once, activation, waiting: false });
    await settle();

    const { el } = mountView({ extension: once, activation, waiting: false });
    expect(el.querySelector(`[data-view]`)).not.toBeNull();
    await advanceTimersByTimeAsync(250);
    expect(waitShown(el)).toBeNull();
});

it(`says nothing while the host has stopped waiting and no view was found`, async () => {
    const { el } = mountView({ waiting: false });
    await advanceTimersByTimeAsync(250);
    expect(waitShown(el)).toBeNull();
    expect(el.textContent).toBe(``);
});
