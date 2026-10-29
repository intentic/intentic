import { effectScope } from "vue";
import * as actualVueRouter from "vue-router";
import { createMemoryHistory, createRouter } from "vue-router";

/* Home's frame (the rail of sandboxes) around a section of a sandbox: worn on the section Home shows of every sandbox when
   it was entered from Home, given back by any other page of a sandbox or by a deliberate step inside, and kept for the
   tab's reloads. A real router, so a duplicate navigation and a step inside are the router's own. */

// The node test environment has neither storage.
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
store(`localStorage`);
const session = store(`sessionStorage`);

const page = { render: () => null };
const router = createRouter({
    history: createMemoryHistory(),
    routes: [
        { path: `/home/:sandbox?`, name: `home`, component: page },
        { path: `/chat`, name: `chat`, component: page },
        { path: `/agents/:id?`, name: `agents`, component: page },
        { path: `/workspace/:path(.*)*`, name: `workspace`, component: page },
        { path: `/settings`, name: `settings`, component: page },
    ],
});
jest.mock("vue-router", () => ({ ...actualVueRouter, useRouter: () => router }));

const { followMasterRail, masterRail } = await import("./masterRail");
const { homeFrame, homeSection } = await import("../../lib/routes/homeSection");
const { goInside } = await import("../../lib/routes/homeDetour");

const WORKSPACE = { id: `workspace`, to: `/workspace`, label: `Workspace` };
const CHAT = { id: `chat`, to: `/chat`, label: `Chat` };

const scope = effectScope();
beforeAll(async () => {
    await router.push(`/home`);
    scope.run(() => followMasterRail());
});
afterAll(() => scope.stop());
beforeEach(async () => {
    homeSection.value = undefined;
    await router.push(`/home`);
});

it(`wears Home's rail on Home's own page, around no section`, () => {
    expect(masterRail.value).toBe(true);
    expect(homeFrame.value).toBeUndefined();
});

it(`keeps Home's frame on the section chosen, the chat docked beside it, and remembers so for a reload`, async () => {
    homeSection.value = WORKSPACE;

    await router.replace(`/workspace/src/a.ts`);

    expect(masterRail.value).toBe(true);
    expect(homeFrame.value).toBe(`docked`);
    expect(session.get(`intentic.masterRail`)).toBe(`1`);
});

it(`frames the Chat as the chat it is, with nothing docked beside`, async () => {
    homeSection.value = CHAT;

    await router.replace(`/chat`);

    expect(homeFrame.value).toBe(`chat`);
});

it(`gives the rail back on any other page of the sandbox`, async () => {
    homeSection.value = WORKSPACE;
    await router.replace(`/workspace`);

    await router.push(`/agents/cnv_1`);

    expect(masterRail.value).toBe(false);
    expect(homeFrame.value).toBeUndefined();
    expect(session.get(`intentic.masterRail`)).toBe(`0`);
});

it(`leaves the frame for a step inside, even onto the very page it was showing`, async () => {
    homeSection.value = WORKSPACE;
    await router.replace(`/workspace`);

    await goInside(() => router.push(`/workspace`));

    expect(masterRail.value).toBe(false);
    expect(homeFrame.value).toBeUndefined();
});

it(`does not put a sandbox's own page in Home's frame when it was reached from inside`, async () => {
    homeSection.value = WORKSPACE;
    await router.push(`/agents`);

    await router.push(`/workspace`);

    expect(masterRail.value).toBe(false);
});

it(`keeps the rail on the person's own pages, around no section`, async () => {
    await router.push(`/settings`);

    expect(masterRail.value).toBe(true);
    expect(homeFrame.value).toBeUndefined();
});
