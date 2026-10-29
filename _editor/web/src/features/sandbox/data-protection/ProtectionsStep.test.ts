// Who applies the public-office preset. It was the owner's alone until applying became Full access's (the daemon's
// floor for `compliance.applyPreset`): the owner and Full access tick and apply, and anybody else who reaches the page
// reads the same ticks with nothing to press and one quiet line saying who applies them. While the reader's access is
// still loading, the line waits, so the owner never reads that it is somebody else's step.
import "@intentic/testing/dom";
import type { ComplianceReport, Measure, PresetItem } from "@intentic/sandbox-contract/schemas/compliance";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";

const known = ref(true);
const mayApply = ref(true);
jest.mock(`../../../client/sandbox/access/useAccess`, () => ({
    useAccess: () => ({ known, can: (route: string) => known.value && route === `compliance.applyPreset` && mayApply.value }),
}));

const measure = (id: Measure[`id`], status: Measure[`status`]): Measure => ({ id, category: `minimisation`, status, facts: {}, preset: true });
const item = (id: string, group: PresetItem[`group`]): PresetItem => ({
    id,
    group,
    current: 30,
    proposed: 7,
    changes: true,
    available: true,
    owner: false,
});
const report = ref<ComplianceReport | undefined>({ generatedAt: `2026-10-29T09:00:00Z`, flows: [], measures: [measure(`retention`, `off`)] });
const items = ref<readonly PresetItem[] | undefined>([item(`retention.cacheDays`, `retention`)]);
jest.mock(`./useCompliance`, () => ({
    useComplianceReport: () => ({ report, isLoading: computed(() => false) }),
    usePreset: () => ({ items, error: ref(undefined), isLoading: computed(() => false), apply: { isPending: ref(false), mutateAsync: jest.fn() } }),
}));
// SAFETY: the stub renders the one prop the step passes (`to`), which is all a RouterLink is asked for here.
jest.mock(`vue-router`, () => ({ ...vueRouterOriginal, RouterLink: RouterLinkStub as never }));

const { default: ProtectionsStep } = await import("./ProtectionsStep.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ProtectionsStep) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    await nextTick();
    return element;
};

const applyButton = (element: HTMLElement): HTMLButtonElement | undefined =>
    [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Apply 1 setting`));
const tick = (element: HTMLElement): HTMLInputElement | null => element.querySelector<HTMLInputElement>(`#preset-retention\\.cacheDays`);

beforeEach(() => {
    known.value = true;
    mayApply.value = true;
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`lets the owner or Full access tick and apply the preset, with no line about who may`, async () => {
    const element = await mount();
    expect(applyButton(element)?.disabled).toBe(false);
    expect(tick(element)?.disabled).toBe(false);
    expect(element.textContent).not.toContain(`can apply these`);
});

it(`shows anybody else the same ticks with nothing to press, and says who applies them`, async () => {
    mayApply.value = false;
    const element = await mount();
    expect(applyButton(element)?.disabled).toBe(true);
    expect(tick(element)?.disabled).toBe(true);
    expect(element.textContent).toContain(`Only the owner or someone with Full access can apply these.`);
});

it(`says nothing about who applies while the reader's access is still loading`, async () => {
    known.value = false;
    const element = await mount();
    expect(applyButton(element)?.disabled).toBe(true);
    expect(element.textContent).not.toContain(`can apply these`);
});
