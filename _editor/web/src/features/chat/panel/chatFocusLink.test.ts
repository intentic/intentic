import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { createApp, h, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

// Pins the full-window chat's half of a notification's press (router/conversationLink.ts): `/chat?focus=<id>` opens
// that conversation once the roster has answered, once, and leaves the address clean.

const opened: string[] = [];
const heard = ref(false);
jest.mock(`../../agents/fleet/useAgents-actions`, () => ({ openById: (id: string) => opened.push(id) }));
jest.mock(`../../agents/fleet/useAgents-registry`, () => ({ rosterHeard: heard }));

const { useChatFocusLink } = await import(`./chatFocusLink`);

const mount = async (path: string): Promise<{ router: Router; unmount: () => void }> => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:all(.*)*`, component: { render: () => null } }] });
    await router.push(path);
    const app = createApp({
        setup() {
            useChatFocusLink();
            return () => h(`div`);
        },
    });
    app.use(router);
    app.mount(document.createElement(`div`));
    return { router, unmount: () => app.unmount() };
};

afterEach(() => {
    opened.length = 0;
    heard.value = false;
});

it(`waits for the roster, then opens the named conversation and drops the focus from the address`, async () => {
    const { router, unmount } = await mount(`/chat?focus=cnv_1`);
    expect(opened).toEqual([]);

    heard.value = true;
    await waitFor(() => expect(opened).toEqual([`cnv_1`]));
    await waitFor(() => expect(router.currentRoute.value.fullPath).toBe(`/chat`));
    unmount();
});

it(`opens a second link that arrives while the chat is already up`, async () => {
    heard.value = true;
    const { router, unmount } = await mount(`/chat?focus=cnv_1`);
    await waitFor(() => expect(opened).toEqual([`cnv_1`]));

    await router.push(`/chat?focus=cnv_2`);
    await waitFor(() => expect(opened).toEqual([`cnv_1`, `cnv_2`]));
    unmount();
});

it(`opens nothing for a chat entered without a focus`, async () => {
    heard.value = true;
    const { unmount } = await mount(`/chat`);
    await Promise.resolve();
    expect(opened).toEqual([]);
    unmount();
});
