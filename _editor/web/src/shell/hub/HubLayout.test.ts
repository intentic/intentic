// @vitest-environment jsdom
//
// WHAT A HUB ROW SAYS ABOUT A RUN THE READER WALKED AWAY FROM. A hub mounts one section at a time, so a rebuild
// started on Environment leaves nothing on screen once Devices is open; the row's mark is the whole of what is
// left. Rendered rather than reasoned about, because both halves are render-time: the mark rides `#meta`, a slot
// Row draws only when it is filled, and the section reports itself through an inject that has to survive being
// passed down a slot.
import { IconStub } from "@intentic/ui/testing";
import { afterEach, expect, it } from "vitest";
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

const mount = async (path: string): Promise<HTMLElement> => {
    await router.push(path);
    await router.isReady();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup() {
            // Built the way the sandbox hub builds it: the count is the row's own, the phrase comes from the ledger.
            const groups = computed(() => {
                const running = hubWorkRunning(DEVICES);
                return [
                    {
                        key: `box`,
                        items: [
                            { slug: `overview`, label: `Overview`, icon: `info-circle` as const },
                            {
                                slug: `devices`,
                                label: `Devices`,
                                icon: `desktop` as const,
                                badge: { count: 1, tone: `info` as const, ...(running === undefined ? {} : { running }) },
                            },
                        ],
                    },
                ];
            });
            return () =>
                h(
                    HubLayout,
                    { title: `Sandbox`, routeName: `sandbox`, defaultSlug: `overview`, groups: groups.value },
                    { default: () => h(Section) },
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
