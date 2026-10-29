// The product analytics switch on the Privacy shield page. That page opens to someone given the Privacy shield, but the
// switch writes the sandbox's settings, which are Full access's: such a reader sees where it stands and who changes it,
// with no switch that would be refused. While their access is still loading the switch stands, and the daemon decides.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";

const known = ref(true);
const maySet = ref(true);
jest.mock(`../../../client/sandbox/access/useAccess`, () => ({
    useAccess: () => ({ known, can: (route: string) => known.value && route === `settings.set` && maySet.value }),
}));
const settings = ref<{ productAnalytics: boolean } | undefined>({ productAnalytics: false });
const patch = jest.fn();
jest.mock(`../../../models/sandbox/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings, patch, refusal: ref(undefined) }) }));

const { default: SandboxAnalytics } = await import("./SandboxAnalytics.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(SandboxAnalytics) });
    app.use(PrimeVue);
    app.component(`Icon`, { template: `<i />` });
    app.mount(element);
    await nextTick();
    return element;
};
const toggle = (element: HTMLElement): Element | null => element.querySelector(`[aria-label="Intentic product analytics in this sandbox"]`);

beforeEach(() => {
    known.value = true;
    maySet.value = true;
    settings.value = { productAnalytics: false };
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`gives the owner or Full access the switch`, async () => {
    const element = await mount();
    expect(toggle(element)).not.toBeNull();
    expect(element.textContent).not.toContain(`changes this`);
});

it(`shows someone given only the Privacy shield where it stands and who changes it, with no switch`, async () => {
    maySet.value = false;
    const element = await mount();
    expect(toggle(element)).toBeNull();
    expect(element.textContent).toContain(`Off`);
    expect(element.textContent).toContain(`The owner or someone with Full access changes this.`);
});

it(`keeps the switch while the reader's access is still loading`, async () => {
    known.value = false;
    const element = await mount();
    expect(toggle(element)).not.toBeNull();
    expect(element.textContent).not.toContain(`changes this`);
});
