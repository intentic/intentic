import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

// Sign out that did not sign anybody out says why, in the menu it was pressed in: a local window whose app could not
// reach the platform, or a platform that refused. Until 2026-10-12 the press lock swallowed the rejection, the menu stayed
// as it was, and the reader stayed signed in without a word.

const signOut = jest.fn(async (): Promise<void> => undefined);
const account = {
    user: ref({ id: `u1`, email: `ada@example.com`, name: `Ada`, image: null }),
    refresh: async () => null,
    updateProfile: async () => undefined,
    signOut,
    settled: async () => undefined,
    local: true,
};
jest.mock(`../client/auth/useAccount`, () => ({ useAccount: () => account }));
jest.mock(`../models/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ planBadge: ref(undefined) }) }));
jest.mock(`../features/gettingStarted/useGettingStarted`, () => ({ useGettingStarted: () => ({ reopenable: ref(false), show: async () => undefined }) }));
jest.mock(`../workbench/commands/useCommands`, () => ({ registerCommand: () => ({ dispose: () => undefined }) }));

const { default: AccountPanel } = await import("./AccountPanel.vue");

let app: App | undefined;
let el: HTMLElement | undefined;
afterEach(() => {
    app?.unmount();
    el?.remove();
    app = undefined;
    signOut.mockReset();
});

// The press settles a few ticks after it lands. Microtasks only: the overlay's own timers are not this test's business.
const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick += 1) {
        await nextTick();
        await Promise.resolve();
    }
};

const mountPanel = async (): Promise<void> => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:all(.*)*`, component: { render: () => null } }] });
    await router.push(`/workspace`);
    el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AccountPanel) });
    app.use(router);
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await router.isReady();
    const trigger = el.querySelector<HTMLButtonElement>(`button[aria-haspopup="dialog"]`);
    if (trigger === null) {
        throw new Error(`the account control did not render`);
    }
    // Where the rail draws it: an anchor with no size is one the overlay closes on rather than points at.
    trigger.getBoundingClientRect = () => DOMRect.fromRect({ x: 8, y: 700, width: 36, height: 36 });
    trigger.click();
    await settle();
};

const pressSignOut = async (): Promise<void> => {
    // The menu's last row, and its only button among them: Settings is a link.
    const row = [...document.body.querySelectorAll<HTMLButtonElement>(`button[data-menu-row]`)].at(-1);
    if (row === undefined) {
        throw new Error(`the menu did not open`);
    }
    row.click();
    await settle();
};

const failure = (): string | undefined => document.body.querySelector(`[data-test="sign-out-failure"]`)?.textContent?.trim();

test(`a sign-out that failed says why in the menu, which stays open on it`, async () => {
    signOut.mockImplementation(async () => {
        throw new Error(`The platform could not be reached.`);
    });
    await mountPanel();
    await pressSignOut();
    expect([signOut.mock.calls.length, failure()]).toEqual([1, `The platform could not be reached.`]);
});

test(`a sign-out that went through says nothing`, async () => {
    await mountPanel();
    await pressSignOut();
    expect([signOut.mock.calls.length, failure()]).toEqual([1, undefined]);
});
