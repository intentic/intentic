// Activity's parts by who reads it and what is switched on: the extension's turns, then the judge's and the shield's
// records, which stay when the extension is off, and which a member below maintainer never sees.
// jsdom: mounts the component tree and reads rendered DOM.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { type App, computed, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IconStub } from "@intentic/ui/testing";

const canShip = ref(true);
const hiddenAgent = ref(false);
jest.mock(`../../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip: computed(() => canShip.value) }) }));
jest.mock(`../../organisations/useOrgPolicy`, () => ({
    useOrgPolicy: () => ({ modeOf: (slug: string) => (hiddenAgent.value && slug !== `activity` ? `hidden` : `open`) }),
}));

const stub = (name: string) => ({ default: defineComponent({ render: () => h(`section`, { "data-part": name }) }) });
jest.mock(`../guardrails/AgentSafetyLog.vue`, () => stub(`commands`));
jest.mock(`../privacy-shield/PrivacyShieldRecord.vue`, () => stub(`personal`));

const { default: SandboxActivity } = await import("./SandboxActivity.vue");


let app: App | undefined;
// The hub hands the extension's view in as the `turns` slot; a section stands in for it here.
const mount = async (query: Record<string, string> = {}, { turns }: { turns: boolean } = { turns: true }): Promise<{ el: HTMLElement; router: Router }> => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
    });
    await router.push({ name: `sandbox`, params: { tab: `activity` }, query });
    await router.isReady();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxActivity, { turns }, { turns: () => h(`section`, { "data-part": `turns` }) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return { el, router };
};

const shown = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-part]`)].map((node) => node.getAttribute(`data-part`)!);
const tabs = (el: HTMLElement): string[] => [...el.querySelectorAll(`button[role="tab"]`)].map((button) => button.textContent?.trim() ?? ``);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    canShip.value = true;
    hiddenAgent.value = false;
});

it(`opens on the turns, with the two records beside them`, async () => {
    const { el } = await mount();
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([`Turns`, `Commands checked`, `Personal data`]);
});

it(`opens the record a settings page linked to, with the way back to those settings`, async () => {
    const { el } = await mount({ section: `commands` });
    expect(shown(el)).toEqual([`commands`]);
    expect(el.querySelector(`a[href="/sandbox/guardrails"]`)).not.toBeNull();

    app?.unmount();
    document.body.innerHTML = ``;
    const { el: personal } = await mount({ section: `personal` });
    expect(shown(personal)).toEqual([`personal`]);
    expect(personal.querySelector(`a[href="/sandbox/privacy-shield"]`)).not.toBeNull();
});

it(`keeps both records when the extension is switched off, and says where the turns went`, async () => {
    const { el } = await mount({ section: `commands` }, { turns: false });
    expect(shown(el)).toEqual([`commands`]);
    expect(tabs(el)).toEqual([`Turns`, `Commands checked`, `Personal data`]);
    (el.querySelectorAll<HTMLButtonElement>(`button[role="tab"]`)[0])?.click();
    await waitFor(() => expect(el.querySelector(`a[href="/sandbox/extensions"]`)).not.toBeNull());
});

it(`shows a member their turns alone, with no strip to pick from`, async () => {
    canShip.value = false;
    const { el } = await mount({ section: `commands` });
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([]);
});

it(`leaves out the records whose pages an organisation hides`, async () => {
    hiddenAgent.value = true;
    const { el } = await mount({ section: `personal` });
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([]);
});
