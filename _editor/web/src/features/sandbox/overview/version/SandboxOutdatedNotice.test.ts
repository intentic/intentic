// The one word for a sandbox older than what reads it: what the section won't show, and how to update, which is one press
// to the Sandbox page's Update card, or `ic sandbox update <slug>` on the machine of a sandbox installed by hand. The
// slug rides along because a machine running several sandboxes refuses the bare verb.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const slug = ref<string | undefined>(`sandbox-3c469e9d6c58`);
jest.mock(`../../environment/servingSlug`, () => ({ useServingSlug: () => slug }));

const { default: SandboxOutdatedNotice } = await import("./SandboxOutdatedNotice.vue");

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
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says the sandbox is older and what won't show, leads to the Sandbox page's update, and names the manual command`, async () => {
    const el = await mount();
    expect(el.querySelector(`[data-outdated]`)).not.toBeNull();
    expect(el.textContent).toContain(`Who broke main won't show here until it updates.`);
    expect(el.querySelector(`[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    expect(el.querySelector(`code`)?.textContent).toBe(`ic sandbox update sandbox-3c469e9d6c58`);
});

// Only a page that cannot know the name prints the bare verb, which still works on a machine running just this one.
it(`prints the bare verb only when the sandbox's name is unknown here`, async () => {
    slug.value = undefined;
    const el = await mount();
    expect(el.querySelector(`code`)?.textContent).toBe(`ic sandbox update`);
});
