//
// WHAT A HUB ROW SAYS ABOUT A RUN THE READER WALKED AWAY FROM. A hub mounts one section at a time, so a rebuild
// started on Environment leaves nothing on screen once Devices is open; the row's mark is the whole of what is
// left. Rendered rather than reasoned about, because both halves are render-time: the mark rides `#meta`, a slot
// Row draws only when it is filled, and the section reports itself through an inject that has to survive being
// passed down a slot.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { beginHubWork, forgetHubWork, hubWorkKey, hubWorkRunning, useHubWork } from "./hubWork";
import HubLayout from "./HubLayout.vue";

const DEVICES = hubWorkKey(`sandbox`, `devices`);

// The hub's own route shape, not the app's: the real router sends a signed-out test to the platform gate, which
// leaves `:tab` empty and every section looking like the default one.
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/`, name: `home`, component: { render: () => undefined } },
        { path: `/sandbox/:tab?`, name: `sandbox`, component: { render: () => undefined } },
    ],
});

// Stands in for a section: it starts work the way a card does, through the inject the hub provides.
const Section = defineComponent({
    name: `Section`,
    setup() {
        const hubWork = useHubWork();
        return () => h(`button`, { type: `button`, onClick: () => hubWork.begin(`Updating a container`) }, `Start`);
    },
});

let app: App | undefined;

// A row standing for two sections, as Privacy & safety stands for its pages: one row in the index, the sections as tabs.
const PRIVACY = {
    slug: `privacy`,
    label: `Privacy & safety`,
    icon: `lock` as const,
    parts: [
        { slug: `data-protection`, label: `Data protection`, icon: `lock` as const },
        { slug: `retention`, label: `Retention`, icon: `history` as const },
    ],
};

// `listed` is the index as it stands this render — a hub whose sections arrive with a read has fewer of them for as
// long as the read takes, which is what `ready` is about. `tabbed` adds the row above as a group of its own.
const mount = async (path: string, index: { ready?: boolean; listed?: readonly string[]; tabbed?: boolean } = {}): Promise<HTMLElement> => {
    await router.push(path);
    await router.isReady();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup() {
            // Built the way the sandbox hub builds it: the count is the row's own, the phrase comes from the ledger.
            const groups = computed(() => {
                const running = hubWorkRunning(DEVICES);
                const items = [
                    { slug: `overview`, label: `Overview`, icon: `info-circle` as const },
                    {
                        slug: `devices`,
                        label: `Devices`,
                        icon: `desktop` as const,
                        badge: { count: 1, tone: `info` as const, ...(running === undefined ? {} : { running }) },
                    },
                ];
                const box = { key: `box`, items: items.filter((item) => index.listed?.includes(item.slug) ?? true) };
                return index.tabbed === true ? [box, { key: `oversight`, items: [PRIVACY] }] : [box];
            });
            return () =>
                h(
                    HubLayout,
                    { title: `Sandbox`, routeName: `sandbox`, defaultSlug: `overview`, groups: groups.value, ready: index.ready ?? true },
                    // The marker carries the slug the hub handed its body, which is the section on screen.
                    { default: ({ slug }: { slug: string }) => [h(`p`, { "data-section": slug }), h(Section)] },
                );
        },
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    await nextTick();
    return el;
};

const spinners = (el: HTMLElement): Element[] => [...el.querySelectorAll(`[data-icon="spinner"][data-spin]`)];

const section = (el: HTMLElement): string | null | undefined => el.querySelector(`[data-section]`)?.getAttribute(`data-section`);

// The unknown-slug redirect is a navigation, so it lands a turn of the router's own after the render that decided it.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

afterEach(async () => {
    forgetHubWork();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    await router.push(`/`);
});

it(`draws no mark on a row whose only news is a count`, async () => {
    const el = await mount(`/sandbox`);
    expect(el.textContent).toContain(`Devices`);
    expect(spinners(el)).toHaveLength(0);
});

it(`marks the row a run belongs to, and says what it is where a 14rem row cannot`, async () => {
    const el = await mount(`/sandbox`);
    beginHubWork(DEVICES, `Updating a container`);
    await nextTick();
    expect(spinners(el)).toHaveLength(1);
    expect(el.textContent).toContain(`Updating a container`);
    // The count keeps its chip: a run is not an errand, and the two are separate facts about one section.
    expect(el.textContent).toContain(`1`);
});

// A deep link arriving while the index it has to be found in is still being read. This is the address Stripe sends
// a payer back to: `/settings/billing?plan=welcome`, where Billing is a row the plan read has not answered for yet.
// Trading it for the default costs the section AND the query the page's post-checkout wait runs off.
it(`holds a section the index has not listed yet, address and query intact`, async () => {
    const el = await mount(`/sandbox/devices?plan=welcome`, { ready: false, listed: [`overview`] });
    await settle();
    expect(section(el)).toBe(`devices`);
    expect(router.currentRoute.value.fullPath).toBe(`/sandbox/devices?plan=welcome`);
});

it(`cleans a slug that is still unknown once the index is in`, async () => {
    const el = await mount(`/sandbox/nonsense`, { ready: true });
    await settle();
    expect(router.currentRoute.value.path).toBe(`/sandbox`);
    expect(section(el)).toBe(`overview`);
});

// The load-bearing half: a card deep inside the section's body reports its work without being told which row it
// lives on, and the answer is the section it was started from.
it(`attributes a section's own work to the row it was started from`, async () => {
    const el = await mount(`/sandbox/devices`);
    expect(hubWorkRunning(DEVICES)).toBeUndefined();

    // By its words: the compact strip's own pills are buttons too, and they sit above the section's body.
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `Start`)!.click();
    await nextTick();

    expect(hubWorkRunning(DEVICES)).toBe(`Updating a container`);
    expect(spinners(el)).toHaveLength(1);
});

const partTabs = (el: HTMLElement): HTMLButtonElement[] => [
    ...el.querySelectorAll<HTMLButtonElement>(`[role="tablist"][aria-label="Privacy & safety"] [role="tab"]`),
];
const current = (el: HTMLElement): string[] => [...el.querySelectorAll(`[aria-current="true"]`)].map((row) => row.textContent?.trim() ?? ``);

// THE ROW STANDS FOR ITS SECTIONS: one row in the index, current whichever of them is open, opening the first, and the
// sections themselves as tabs above the one on screen, each still at its own address.
it(`draws a row with parts once, current while any of them is open, with their tabs above it`, async () => {
    const el = await mount(`/sandbox/retention`, { tabbed: true });
    expect(section(el)).toBe(`retention`);
    expect(current(el)).toEqual([`Privacy & safety`]);
    expect(el.querySelector(`a[href="/sandbox/data-protection"]`)?.textContent).toContain(`Privacy & safety`);
    expect(partTabs(el).map((tab) => tab.textContent?.trim())).toEqual([`Data protection`, `Retention`]);
    expect(partTabs(el).find((tab) => tab.getAttribute(`aria-selected`) === `true`)?.textContent?.trim()).toBe(`Retention`);
});

it(`moves between a row's sections by their tabs, at each section's own address`, async () => {
    const el = await mount(`/sandbox/retention`, { tabbed: true });
    partTabs(el)[0]?.click();
    await settle();
    expect(router.currentRoute.value.path).toBe(`/sandbox/data-protection`);
    expect(section(el)).toBe(`data-protection`);
});

it(`draws no tabs above a section that is a row of its own`, async () => {
    const el = await mount(`/sandbox/devices`, { tabbed: true });
    expect(section(el)).toBe(`devices`);
    expect(partTabs(el)).toHaveLength(0);
});

it(`gives a row with parts no address of its own`, async () => {
    const el = await mount(`/sandbox/privacy`, { tabbed: true });
    await settle();
    expect(router.currentRoute.value.path).toBe(`/sandbox`);
    expect(section(el)).toBe(`overview`);
});
