import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { createApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { useShellChatLink } from "./shellChatLink";

const mount = async (path: string) => {
    let opened = 0;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:all(.*)*`, component: { render: () => null } }] });
    await router.push(path);
    const app = createApp({ setup() { useShellChatLink(() => { opened++; }); return () => h(`div`); } });
    app.use(router);
    app.mount(document.createElement(`div`));
    return { router, opened: () => opened, unmount: () => app.unmount() };
};

it(`opens a draft once on a cold shell link, retaining the named sandbox`, async () => {
    const page = await mount(`/chat?sandbox=box-a&shellChat=first`);
    await waitFor(() => expect(page.router.currentRoute.value.fullPath).toBe(`/chat?sandbox=box-a`));
    expect(page.opened()).toBe(1);
    await page.router.replace(`/chat?sandbox=box-a`);
    expect(page.opened()).toBe(1);
    page.unmount();
});

it(`hears a second press while chat is already open`, async () => {
    const page = await mount(`/chat`);
    expect(page.opened()).toBe(0);
    await page.router.push(`/chat?sandbox=box-b&shellChat=second`);
    await waitFor(() => expect(page.opened()).toBe(1));
    await waitFor(() => expect(page.router.currentRoute.value.fullPath).toBe(`/chat?sandbox=box-b`));
    await page.router.push(`/chat?sandbox=box-b&shellChat=third`);
    await waitFor(() => expect(page.opened()).toBe(2));
    page.unmount();
});

it(`ignores empty and repeated query values`, async () => {
    for (const path of [`/chat?shellChat=`, `/chat?shellChat=a&shellChat=b`]) {
        const page = await mount(path);
        expect(page.opened()).toBe(0);
        page.unmount();
    }
});
