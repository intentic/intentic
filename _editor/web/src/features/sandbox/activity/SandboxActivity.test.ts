// Activity's parts by who reads it and what is switched on: the extension's turns, then the judge's and the shield's
// records and the audit trail, which stay when the extension is off, and which a member below maintainer never sees.
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
jest.mock(`../audit/SandboxAudit.vue`, () => stub(`audit`));

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

it(`opens on the turns, with the records beside them and the audit trail last`, async () => {
    const { el } = await mount();
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([`Turns`, `Commands checked`, `Personal data`, `Audit log`]);
});

// The audit log was a hub row of its own until 2026-10-17; how it is kept is Retention's now, which its part ends on.
it(`opens the audit trail as a part, with the way to how it is kept`, async () => {
    const { el } = await mount({ section: `audit` });
    expect(shown(el)).toEqual([`audit`]);
    expect(el.querySelector(`a[href="/sandbox/retention"]`)).not.toBeNull();
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

it(`keeps every record when the extension is switched off, and says where the turns went`, async () => {
    const { el } = await mount({ section: `commands` }, { turns: false });
    expect(shown(el)).toEqual([`commands`]);
    expect(tabs(el)).toEqual([`Turns`, `Commands checked`, `Personal data`, `Audit log`]);
    (el.querySelectorAll<HTMLButtonElement>(`button[role="tab"]`)[0])?.click();
    await waitFor(() => expect(el.querySelector(`a[href="/sandbox/extensions"]`)).not.toBeNull());
});

it(`shows a member their turns alone, with no strip to pick from`, async () => {
    canShip.value = false;
    const { el } = await mount({ section: `audit` });
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([]);
});

// The audit trail stays: no organisation holds it, as it is the record of what an organisation's own locks were used for.
it(`leaves out the records whose pages an organisation hides, and keeps the audit trail`, async () => {
    hiddenAgent.value = true;
    const { el } = await mount({ section: `personal` });
    expect(shown(el)).toEqual([`turns`]);
    expect(tabs(el)).toEqual([`Turns`, `Audit log`]);
});
