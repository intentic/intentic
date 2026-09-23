//
// THE ADDRESS STRIPE SENDS A PAYER BACK TO. `/settings/billing?plan=welcome` is always a cold load, and Billing is
// the one section of this hub drawn off a read — so on that first frame the index does not list it. A hub that
// judges an unlisted slug unknown cleans the address away, and the payer lands on another section with the query
// gone, which is the only input the page's post-checkout wait has.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

// The plan read still in flight: `enabled` unanswered, so the Billing row has nothing to be drawn from yet.
const planLoading = ref(true);
jest.mock(`./hosted-plan/useHostedPlan`, () => ({
    useHostedPlan: () => ({ offered: ref(false), isLoading: planLoading }),
}));

// A jest.mock specifier must be a literal string, so the section list cannot be looped over here.
const stub = (slug: string) => ({ default: defineComponent({ render: () => h(`section`, { "data-section": slug }) }) });
jest.mock(`./SettingsProfile.vue`, () => stub(`profile`));
jest.mock(`./SettingsBilling.vue`, () => stub(`billing`));
jest.mock(`./SettingsAppearance.vue`, () => stub(`appearance`));
jest.mock(`./SettingsNotifications.vue`, () => stub(`notifications`));
jest.mock(`./SettingsKeybindings.vue`, () => stub(`keybindings`));
jest.mock(`./SettingsData.vue`, () => stub(`data`));

const { default: SettingsHub } = await import("./SettingsHub.vue");

let app: App | undefined;

const mount = async (path: string): Promise<{ el: HTMLElement; router: Router }> => {
    const router = createRouter({
        history: createMemoryHistory(),
        // The hub's own route, not the app's: the real one's guards would answer a signed-out test with a redirect.
        routes: [{ path: `/settings/:tab?`, name: `settings`, component: defineComponent({ render: () => h(`div`) }) }],
    });
    await router.push(path);
    await router.isReady();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SettingsHub) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    // The unknown-slug redirect is a navigation: it lands a turn of the router's own after the render deciding it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    return { el, router };
};

const shown = (el: HTMLElement): string | null | undefined => el.querySelector(`[data-section]`)?.getAttribute(`data-section`);

afterEach(() => {
    planLoading.value = true;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`opens Billing on a cold load, address and query intact, while the plan read is still out`, async () => {
    const { el, router } = await mount(`/settings/billing?plan=welcome`);
    expect(shown(el)).toBe(`billing`);
    expect(router.currentRoute.value.fullPath).toBe(`/settings/billing?plan=welcome`);
});

it(`shows the default section for a param-less address`, async () => {
    const { el } = await mount(`/settings`);
    expect(shown(el)).toBe(`profile`);
});

it(`cleans a slug that is still unknown once the read has answered`, async () => {
    planLoading.value = false;
    const { el, router } = await mount(`/settings/nonsense`);
    expect(router.currentRoute.value.path).toBe(`/settings`);
    expect(shown(el)).toBe(`profile`);
});
