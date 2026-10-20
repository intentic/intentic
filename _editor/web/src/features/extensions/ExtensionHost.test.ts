// An extension's page while the shell is still finding out whether that view exists: extensions still loading, or the
// repos and capabilities they detect from not answered yet. It draws the wait (the page as it last looked) and never
// "Nothing here", which is a claim only a settled shell can make; once settled, a view nobody contributes says so. A read
// it detects from that failed is said as a failure with a retry: under failing reads the demo's Pipelines, Docs,
// Maintenance and Workflows pages all said "no longer in the workspace" about views nobody could look for.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { Loaded } from "@intentic/extension-api";
import { type App, createApp, h, nextTick, ref, shallowRef } from "vue";
import * as actualVueRouter from "vue-router";

const loaded = shallowRef(false);
const READY: Loaded<unknown> = { state: `ready`, data: {}, refreshing: false, refreshError: undefined };
const panelsRead = ref<Loaded<unknown>>(READY);
const capabilitiesRead = ref<Loaded<unknown>>(READY);

jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: ExtensionHost reads only `params` off the route; nothing else of a resolved location is touched.
    useRoute: () => ({ params: { ext: `deployments`, key: `komodo` }, query: {} }) as never,
}));
jest.mock(`../../workbench/views/extensionStatuses`, () => ({ extensionsLoaded: loaded, extensionStatuses: shallowRef([]) }));
jest.mock(`../../models/extensions/usePanels`, () => ({ usePanels: () => ({ panels: ref([]), loaded: panelsRead }) }));
jest.mock(`../../models/capabilities/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities: ref([]), loaded: capabilitiesRead }),
}));
jest.mock(`../../models/extensions/useExtensions`, () => ({ useExtensions: () => ({ extensions: ref([]) }) }));
// No extension contributes the view: the page is either still waiting or, once settled, empty.
jest.mock(`../../workbench/views/registry`, () => ({ detectActivations: () => [], registeredViews: () => [] }));
jest.mock(`../../app/clientDiagnostics`, () => ({ describeError: () => ({ message: ``, fields: {} }), reportClient: () => undefined }));

const { default: ExtensionHost } = await import("./ExtensionHost.vue");
const { t } = await import("@intentic/ui/i18n");

const mounted: { app: App; el: HTMLElement }[] = [];
beforeEach(() => {
    jest.useFakeTimers();
    loaded.value = false;
    panelsRead.value = READY;
    capabilitiesRead.value = READY;
});
afterEach(() => {
    for (const { app, el } of mounted.splice(0)) {
        app.unmount();
        el.remove();
    }
    jest.useRealTimers();
});

const mountHost = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(ExtensionHost) });
    app.mount(el);
    mounted.push({ app, el });
    return el;
};

const nothingHere = (): string => t(`extensions.extensionHost.nothingHereViewsContent`);

it(`waits, never saying "nothing here", while the extensions are still loading`, async () => {
    const el = mountHost();
    await advanceTimersByTimeAsync(250);

    expect(el.textContent).not.toContain(nothingHere());
    expect(el.querySelector(`[aria-busy="true"]`)).not.toBeNull();
});

it(`waits on the capabilities a view detects from, even with every extension loaded`, async () => {
    loaded.value = true;
    capabilitiesRead.value = { state: `waiting`, since: Date.now(), retry: undefined };
    const el = mountHost();
    await advanceTimersByTimeAsync(250);

    expect(el.textContent).not.toContain(nothingHere());
    expect(el.querySelector(`[aria-busy="true"]`)).not.toBeNull();
});

it(`says the view is gone once everything has answered and nobody contributes it`, async () => {
    const el = mountHost();
    loaded.value = true;
    await nextTick();
    await advanceTimersByTimeAsync(250);

    expect(el.querySelector(`[aria-busy="true"]`)).toBeNull();
    expect(el.textContent).toContain(nothingHere());
});

it(`says a failed read of what views are detected from as a failure with a retry, never "nothing here"`, async () => {
    const retry = jest.fn();
    loaded.value = true;
    panelsRead.value = { state: `failed`, error: `The sandbox said no.`, retry };
    const el = mountHost();
    await advanceTimersByTimeAsync(250);

    expect(el.textContent).not.toContain(nothingHere());
    expect(el.textContent).toContain(t(`extensions.extensionHost.couldntFindViews`));
    expect(el.textContent).toContain(`The sandbox said no.`);
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(t(`ui.action.tryAgain`)))?.click();
    expect(retry).toHaveBeenCalledTimes(1);
});
