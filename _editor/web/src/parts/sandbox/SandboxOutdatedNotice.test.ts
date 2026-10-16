// The one word for a sandbox older than what reads it: what the section won't show, and how to update, which is one press
// to the Sandbox page's Update card, or the `update/<slug>` one-liner on the device of a sandbox installed by hand. The
// slug rides along because a device running several sandboxes refuses the bare verb.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const slug = ref<string | undefined>(`sandbox-3c469e9d6c58`);
jest.mock(`../../models/sandbox/environment/servingSlug`, () => ({ useServingSlug: () => slug }));
// The connected machine running it, when this sandbox reaches one; none unless a case says so.
const runsOn = ref<string | undefined>(undefined);
jest.mock(`../../models/sandbox/devices/useDevices`, () => ({ useHostRunning: () => runsOn }));

const { default: SandboxOutdatedNotice } = await import("./SandboxOutdatedNotice.vue");
const { scriptSource } = await import("../../app/environments/scriptCommand");
const { useOsPreference } = await import("@intentic/ui");

beforeEach(() => {
    scriptSource.value = `published`;
    useOsPreference().cmdOs.value = `unix`;
});

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    const page = defineComponent({ render: () => h(`div`) });
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/`, component: page },
            { path: `/sandbox/:tab?`, name: `sandbox`, component: page },
        ],
    });
    await router.push(`/`);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxOutdatedNotice, { missing: `Who broke main won't show here until it updates.` }) });
    app.use(router);
    app.component(`Icon`, IconStub);
    app.mount(el);
    return el;
};

afterEach(() => {
    slug.value = `sandbox-3c469e9d6c58`;
    runsOn.value = undefined;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says the sandbox is older and what won't show, leads to the Sandbox page's update, and names the manual command`, async () => {
    const el = await mount();
    expect(el.querySelector(`[data-outdated]`)).not.toBeNull();
    expect(el.textContent).toContain(`Who broke main won't show here until it updates.`);
    expect(el.querySelector(`[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    expect(el.querySelector(`pre`)?.textContent).toBe(`curl -fsSL https://intentic.dev/update/sandbox-3c469e9d6c58 | sh`);
});

// Only a page that cannot know the name prints the bare verb, which still works on a machine running just this one.
it(`prints the bare verb only when the sandbox's name is unknown here`, async () => {
    slug.value = undefined;
    const el = await mount();
    expect(el.querySelector(`pre`)?.textContent).toBe(`ic sandbox update`);
});

// The link leads to a press there: printing the recipe beside it would ask for the one thing a button already does.
it(`leaves the command out when this sandbox reaches the machine it runs on`, async () => {
    runsOn.value = `rog`;
    const el = await mount();
    expect(el.querySelector(`[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    expect(el.querySelector(`pre`)).toBeNull();
    expect(el.textContent).not.toContain(`Installed it yourself?`);
});
