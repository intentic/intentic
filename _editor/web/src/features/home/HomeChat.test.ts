// What Home shows when the selected sandbox's home conversation cannot open. A sandbox from before home conversations
// (its hello lists no `agents.home`) gets the update and the way inside, never a failure whose Retry could not mend it;
// one older than this app supports gets the workspace's own too-old page; any other failure says why.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { HomeConversation } from "@intentic/sandbox-contract/schemas/agents-list";
import { installI18n } from "@intentic/ui/i18n";
import { type App, computed, createApp, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const stub = (attribute: string) => ({ default: defineComponent({ render: () => h(`div`, { [attribute]: `` }) }) });
jest.mock(`./HomeChatSlot.vue`, () => stub(`data-home-slot`));
jest.mock(`./HomeDetour.vue`, () => stub(`data-home-detour`));
jest.mock(`./HomeNoSandbox.vue`, () => stub(`data-home-none`));
jest.mock(`../chat/panel/ChatPane.vue`, () => stub(`data-chat-pane`));
jest.mock(`../sandbox/gates/SandboxConnecting.vue`, () => stub(`data-connecting`));
jest.mock(`../sandbox/gates/SandboxWarming.vue`, () => stub(`data-warming`));
jest.mock(`../sandbox/gates/SandboxTooOld.vue`, () => stub(`data-too-old`));
// The notice has its own place in the app; here it only has to be there, saying what Home goes without.
jest.mock(`../../parts/sandbox/SandboxOutdatedNotice.vue`, () => ({
    default: defineComponent({ props: { missing: { type: String, required: true } }, setup: (props) => () => h(`div`, { "data-outdated": `` }, props.missing) }),
}));

const box = { id: `box-1`, name: `workspace`, lastSeenAt: `2026-10-27T00:00:00Z`, role: `owner` };
const sandboxes = ref([box]);
const activeSandboxId = ref<string | undefined>(box.id);
const reachable = ref(true);
jest.mock(`../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ sandboxes, activeSandboxId, reachable, active: computed(() => box) }),
}));
const home = jest.fn<(input: undefined, options: unknown) => Promise<HomeConversation>>();
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: { agents: { home } } }));
jest.mock(`../../models/home/homeChat`, () => ({
    homeConversation: shallowRef(),
    homeShownFor: shallowRef(),
    homeConversationFor: (_sandboxId: string, answer: { conversationId: string }) => ({ conversationId: answer.conversationId }),
}));
jest.mock(`../../models/fleet/useAgents-registry`, () => ({ registry: ref([]) }));
jest.mock(`../../models/home/homeFacts`, () => ({ workLedger: () => [] }));
jest.mock(`../../client/sandbox/useRole`, () => ({ useRole: () => ({ canLandHome: computed(() => true) }) }));
jest.mock(`../../models/workspace/tree/useWorkspaceTree`, () => ({ useWorkspaceTree: () => ({ hasSnapshot: ref(true) }) }));
jest.mock(`../sandbox/overview/useSandboxAvailability`, () => ({ useSandboxAvailability: () => computed(() => `ready`) }));
jest.mock(`../../models/sandbox/sandboxScreen`, () => ({ sandboxEntryPath: (id: string) => `/agents?in=${id}` }));

const { setDaemonRoutes } = await import("../../client/sandbox/useDaemonRoutes");
const { setDaemonVersion } = await import("../../client/sandbox/daemon/useDaemonVersion");
const { default: HomeChat } = await import("./HomeChat.vue");

const HOME_ROUTE = `agents.home`;

let app: App | undefined;
let router: ReturnType<typeof createRouter>;
// A rejected call, the watch it settles, and a router push each take turns of their own; a macrotask covers all three.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};
const mount = async (): Promise<HTMLElement> => {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:path(.*)*`, component: defineComponent({ render: () => null }) }] });
    await router.push(`/home`);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(HomeChat) });
    app.use(router);
    installI18n(app);
    app.mount(el);
    await settle();
    return el;
};

beforeEach(() => {
    resetSandboxScope();
    reachable.value = true;
    activeSandboxId.value = box.id;
    setDaemonVersion(undefined);
    setDaemonRoutes(undefined);
    home.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the update and the way inside a sandbox from before home conversations, never a Retry that cannot mend it`, async () => {
    setDaemonRoutes([`agents.list`, `system.session`]);
    home.mockRejectedValue(Object.assign(new Error(`Not Found`), { status: 404 }));
    const el = await mount();
    expect(el.querySelector(`[data-outdated]`)?.textContent).toContain(`Your home conversation needs a newer version.`);
    expect(el.textContent).not.toContain(`Could not open your home conversation.`);
    expect(home).not.toHaveBeenCalled();
    const open = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Open workspace`));
    expect(open).toBeInstanceOf(HTMLButtonElement);
    open?.click();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe(`/agents?in=${box.id}`);
});

it(`turns to the update as soon as the hello says the route is missing, after a call that went out before it`, async () => {
    home.mockRejectedValue(Object.assign(new Error(`Not Found`), { status: 404 }));
    const el = await mount();
    expect(el.textContent).toContain(`Could not open your home conversation.`);
    setDaemonRoutes([`agents.list`]);
    await settle();
    expect(el.querySelector(`[data-outdated]`)).not.toBeNull();
    expect(el.textContent).not.toContain(`Could not open your home conversation.`);
});

it(`stands the workspace's own too-old page in front of a sandbox below the floor`, async () => {
    setDaemonVersion(`1.200.0:1`);
    setDaemonRoutes([`agents.list`]);
    const el = await mount();
    expect(el.querySelector(`[data-too-old]`)).not.toBeNull();
    expect(home).not.toHaveBeenCalled();
});

it(`says why any other failure happened, and asks again on Retry`, async () => {
    setDaemonRoutes([HOME_ROUTE]);
    home.mockRejectedValueOnce(new Error(`A home conversation is a person's: sign in as a member to open yours.`));
    home.mockResolvedValueOnce({ conversationId: `home-abc`, lands: `itself` });
    const el = await mount();
    expect(el.textContent).toContain(`Could not open your home conversation.`);
    expect(el.textContent).toContain(`sign in as a member to open yours`);
    const retry = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Try again`));
    retry?.click();
    await settle();
    expect(home).toHaveBeenCalledTimes(2);
    expect(el.querySelector(`[data-home-slot]`)).not.toBeNull();
});

it(`opens the chat when the sandbox answers`, async () => {
    setDaemonRoutes([HOME_ROUTE]);
    home.mockResolvedValue({ conversationId: `home-abc`, lands: `itself` });
    const el = await mount();
    expect(el.querySelector(`[data-home-slot]`)).not.toBeNull();
    expect(el.querySelector(`[data-outdated]`)).toBeNull();
});
