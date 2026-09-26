// The one word for a sandbox older than what reads it: what the section won't show, and how to update, which is one press
// to the Sandbox page's Update card, or `ic sandbox update` on the machine of a sandbox installed by hand.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

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
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says the sandbox is older and what won't show, leads to the Sandbox page's update, and names the manual command`, async () => {
    const el = await mount();
    expect(el.querySelector(`[data-outdated]`)).not.toBeNull();
    expect(el.textContent).toContain(`Who broke main won't show here until it updates.`);
    expect(el.querySelector(`[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    expect(el.querySelector(`code`)?.textContent).toBe(`ic sandbox update`);
});
